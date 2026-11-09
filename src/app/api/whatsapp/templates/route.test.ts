import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.fn();
const toErrorResponse = vi.fn();
const supabaseAdmin = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  toErrorResponse: (error: unknown) => toErrorResponse(error),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => supabaseAdmin(),
}));

import { GET } from './route';

describe('GET /api/whatsapp/templates', () => {
  beforeEach(() => {
    requireRole.mockResolvedValue({ accountId: 'account-1' });
  });

  it('lists only approved templates in the current account', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'template-1', name: 'reminder', language: 'en_US' }],
        error: null,
      }),
    };
    const admin = { from: vi.fn(() => query) };
    supabaseAdmin.mockReturnValue(admin);

    const response = await GET();

    expect(requireRole).toHaveBeenCalledWith('viewer');
    expect(query.eq).toHaveBeenNthCalledWith(1, 'account_id', 'account-1');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'status', 'APPROVED');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      templates: [{ id: 'template-1', name: 'reminder', language: 'en_US' }],
    });
  });

  it('returns the Supabase error on query failure', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'template query failed' },
      }),
    };
    supabaseAdmin.mockReturnValue({ from: vi.fn(() => query) });

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'template query failed',
    });
  });
});
