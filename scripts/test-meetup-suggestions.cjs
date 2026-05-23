// Tests GET /ai/meetup/suggestions across 3 user profiles:
//   1. Rich connections (default — pick user with most connections)
//   2. User with 0 connections
//   3. Edge: user with h3_cell but minimal profile
require('dotenv').config({ path: 'C:/Users/akash/onedrive/desktop/main-logic/.env' });
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { createClient: createRedis } = require('redis');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function clearCache(userId) {
  const r = createRedis({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  await r.connect();
  await r.del('meetup:suggestions:' + userId);
  await r.quit();
}

async function callSuggestions(label, user) {
  console.log('\n=== ' + label + ' ===');
  console.log('user:', user.first_name, '|', user.id);
  await clearCache(user.id);
  const token = jwt.sign(
    { sub: user.id, phone: '+0000000000', type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const t0 = Date.now();
  const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const res = await fetch(baseUrl + '/ai/meetup/suggestions', {
    headers: { Authorization: 'Bearer ' + token, 'accept-language': 'en' },
  });
  const ms = Date.now() - t0;
  let body;
  try { body = await res.json(); } catch { body = { _raw: await res.text() }; }
  console.log('status:', res.status, '| time:', ms + 'ms');
  console.log(JSON.stringify(body, null, 2));
  return { status: res.status, body, ms };
}

(async () => {
  // === Scenario 1: rich user (most accepted connections) ===
  const { data: users } = await sb
    .from('users')
    .select('id, first_name, h3_cell')
    .not('h3_cell', 'is', null)
    .limit(30);
  let bestUser = null; let bestCount = -1;
  for (const u of users || []) {
    const { count } = await sb
      .from('connections').select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${u.id},addressee_id.eq.${u.id}`).eq('status', 'accepted');
    if ((count ?? 0) > bestCount) { bestCount = count ?? 0; bestUser = u; }
  }
  if (bestUser) {
    await callSuggestions('Scenario 1: rich user (' + bestCount + ' connections)', bestUser);
  } else {
    console.log('no rich user found');
  }

  // === Scenario 2: user with 0 connections ===
  let zeroUser = null;
  for (const u of users || []) {
    const { count } = await sb
      .from('connections').select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${u.id},addressee_id.eq.${u.id}`).eq('status', 'accepted');
    if ((count ?? 0) === 0) { zeroUser = u; break; }
  }
  if (zeroUser) {
    await callSuggestions('Scenario 2: zero connections', zeroUser);
  } else {
    console.log('\n(skipping zero-connection scenario — all sampled users have connections)');
  }

  console.log('\n=== Done ===');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
