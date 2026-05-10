import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Create a Supabase client with the Auth context of the logged in user
    const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '')

    // Parse request body for optional filters
    const { country_code, search } = await req.json().catch(() => ({}))

    // Build query
    let query = supabaseClient
      .from('countries')
      .select('country_name, country_code, flag_url, phone_code')
      .order('country_name', { ascending: true })

    // Apply filters if provided
    if (country_code) {
      query = query.ilike('country_code', `%${country_code}%`)
    }

    if (search) {
      query = query.ilike('country_name', `%${search}%`)
    }

    // Execute query
    const { data, error } = await query

    if (error) {
      throw error
    }

    // Return successful response
    return new Response(
      JSON.stringify({
        success: true,
        data: data,
        count: data?.length || 0
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    )

  } catch (error) {
    // Return error response
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      },
    )
  }
})
