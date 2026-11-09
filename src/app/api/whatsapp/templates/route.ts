import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const { accountId } = await requireRole('viewer');
    const { data: templates, error } = await supabaseAdmin()
      .from('message_templates')
      .select('id, name, language, category, body_text')
      .eq('account_id', accountId)
      .eq('status', 'APPROVED')
      .order('name', { ascending: true });

    if (error) {
      console.error('[webinar-templates] lookup failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ templates: templates ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
