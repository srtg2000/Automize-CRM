import { describe, expect, it } from 'vitest';

import {
  CREATABLE_NODE_TYPES,
  NODE_CATEGORIES,
  NODE_META,
  groupNodeTypesByCategory,
  summarizeNode,
  type NodeType,
} from './shared';

const ALL_TYPES = Object.keys(NODE_META) as NodeType[];

describe('node categories', () => {
  it('assigns every node type to a known category', () => {
    const known = new Set(NODE_CATEGORIES);
    for (const type of ALL_TYPES) {
      expect(known.has(NODE_META[type].category)).toBe(true);
    }
  });
});

describe('groupNodeTypesByCategory', () => {
  it('includes Register to Webinar in the shared add-node menu types', () => {
    expect(CREATABLE_NODE_TYPES).toContain('register_webinar');
    expect(NODE_META.register_webinar.icon).toBeDefined();
    expect(NODE_META.register_webinar.color).toBe('text-violet-400');
  });

  it('keeps the categories in NODE_CATEGORIES order and drops empty ones', () => {
    // Only messaging + flow types — the logic group must not appear.
    const groups = groupNodeTypesByCategory(['send_message', 'start', 'end']);
    expect(groups.map((g) => g.id)).toEqual(['messaging', 'flow']);
  });

  it('preserves the input order within a category', () => {
    const groups = groupNodeTypesByCategory([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
  });

  it('partitions the full type list without losing or duplicating a type', () => {
    const grouped = groupNodeTypesByCategory(ALL_TYPES).flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe('summarizeNode webinar fallbacks', () => {
  const webinarNode = (webinarId: string) => ({
    node_key: 'register-webinar',
    node_type: 'register_webinar' as const,
    config: { webinarId },
  });

  it('uses the fallback when the webinar translation is unavailable', () => {
    const missingTranslation = Object.assign(
      new Error('Missing message'),
      { code: 'MISSING_MESSAGE' }
    );
    const t = () => {
      throw missingTranslation;
    };

    expect(summarizeNode(webinarNode('12345678-90ab'), t)).toBe(
      'Register for webinar 12345678'
    );
    expect(summarizeNode(webinarNode(''), t)).toBe('No webinar selected');
  });

  it('does not hide errors other than missing translations', () => {
    const t = () => {
      throw new Error('Unexpected translation failure');
    };
    expect(() => summarizeNode(webinarNode('12345678-90ab'), t)).toThrow(
      'Unexpected translation failure'
    );
  });
});
