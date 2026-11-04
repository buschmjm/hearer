import { DEFAULT_NAMING_TEMPLATE, DEFAULT_SINGLES_TEMPLATE } from '@hearer/shared';
import { describe, expect, it } from 'vitest';
import { SAMPLE_ALBUM_TRACK, renderTemplate, validateTemplate } from '../src/lib/template.ts';

describe('naming template preview', () => {
  it('renders the default album template', () => {
    expect(renderTemplate(DEFAULT_NAMING_TEMPLATE)).toBe(
      'Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    );
  });

  it('adds the disc prefix only for multi-disc releases', () => {
    const multi = { ...SAMPLE_ALBUM_TRACK, disc: 2, discCount: 2 };
    expect(renderTemplate('{disc:?}{track:02}', multi)).toBe('2-02');
    expect(renderTemplate('{disc:?}{track:02}')).toBe('02');
  });

  it('renders singles and pads numbers', () => {
    expect(renderTemplate(DEFAULT_SINGLES_TEMPLATE)).toBe(
      'Radiohead/Singles/Paranoid Android.flac',
    );
    expect(renderTemplate('{track:03}')).toBe('002');
  });

  it('replaces path separators inside values and keeps unknown variables visible', () => {
    const tricky = { ...SAMPLE_ALBUM_TRACK, title: 'AC/DC: Live?' };
    expect(renderTemplate('{title}.{ext}', tricky)).toBe('AC_DC_ Live_.flac');
    expect(renderTemplate('{nope}')).toBe('{nope}');
  });

  it('accepts the defaults and flags bad templates', () => {
    expect(validateTemplate(DEFAULT_NAMING_TEMPLATE)).toEqual([]);
    expect(validateTemplate(DEFAULT_SINGLES_TEMPLATE)).toEqual([]);
    expect(validateTemplate('{artist}/{nope}/{title}.{ext}')).toContain('Unknown variable {nope}');
    expect(validateTemplate('{artist}/{track:xx}/{title}.{ext}')[0]).toMatch(/Bad format/);
    expect(validateTemplate('{artist}.{ext}')[0]).toMatch(/\{title\}/);
    expect(validateTemplate('{title}')[0]).toMatch(/\{ext\}/);
    expect(validateTemplate('../{title}.{ext}')[0]).toMatch(/relative/);
    expect(validateTemplate('/abs/{title}.{ext}')[0]).toMatch(/relative/);
    expect(validateTemplate('{title.{ext}')).toContain('Unbalanced braces');
  });
});
