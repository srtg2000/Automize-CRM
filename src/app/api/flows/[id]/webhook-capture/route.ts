import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { createClient } from '@/lib/supabase/server';

async function authorizeFlow(id: string) {
  try {
    await requireRole('agent');
  } catch (error) {
    return { response: toErrorResponse(error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const { data: flow } = await supabase
    .from('flows')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (!flow) {
    return {
      response: NextResponse.json(
        { error: 'Flow not found.' },
        { status: 404 }
      ),
    };
  }
  return { admin: supabaseAdmin() };
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authorization = await authorizeFlow(id);
  if ('response' in authorization) return authorization.response;

  const { error } = await authorization.admin
    .from('flow_webhook_captures')
    .delete()
    .eq('flow_id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data, error: insertError } = await authorization.admin
    .from('flow_webhook_captures')
    .insert({
      flow_id: id,
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    })
    .select('token, expires_at')
    .single();
  if (insertError || !data) {
    return NextResponse.json(
      { error: insertError?.message ?? 'Unable to start capture.' },
      { status: 500 }
    );
  }
  return NextResponse.json({ token: data.token, expires_at: data.expires_at });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authorization = await authorizeFlow(id);
  if ('response' in authorization) return authorization.response;

  const token = new URL(request.url).searchParams.get('token');
  if (!token) {
    return NextResponse.json(
      { error: 'Capture token is required.' },
      { status: 400 }
    );
  }
  const { data, error } = await authorization.admin
    .from('flow_webhook_captures')
    .select('captured_fields, captured_at, expires_at')
    .eq('flow_id', id)
    .eq('token', token)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || new Date(data.expires_at).getTime() <= Date.now()) {
    return NextResponse.json(
      { error: 'Capture session expired.' },
      { status: 410 }
    );
  }
  return NextResponse.json({
    fields: data.captured_fields ?? null,
    captured_at: data.captured_at ?? null,
  });
}
