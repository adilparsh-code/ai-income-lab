// Regression tests for the halal screen (audit findings: substring false
// positives, trivial evasions, uncovered terms). Pure functions, no DB.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { screenForHalalCompliance } from '@/lib/halal-filter';

const screen = (title: string, desc = 'x', cat = 'Digital Products') =>
  screenForHalalCompliance(title, desc, cat, 'Digital product', 'One-time sale').status;

describe('halal filter: evasion resistance', () => {
  it('blocks Cyrillic look-alike letters', () => assert.equal(screen('Gаmbling strategy guide'), 'NOT_ALLOWED'));
  it('blocks zero-width joiners inside a term', () => assert.equal(screen('Cas​ino affiliate'), 'NOT_ALLOWED'));
  it('blocks spaced-out letters', () => assert.equal(screen('g a m b l i n g tips'), 'NOT_ALLOWED'));
  it('blocks fullwidth / accented forms', () => {
    assert.equal(screen('ｃａｓｉｎｏ bonus'), 'NOT_ALLOWED');
    assert.equal(screen('Cásino bonus'), 'NOT_ALLOWED');
  });
  it('blocks terms the old list missed', () => {
    for (const t of ['Sports wagering tips', 'Sportsbook comparison', 'Binary options signals', 'NSFW commissions']) {
      assert.equal(screen(t), 'NOT_ALLOWED', t);
    }
  });
  it('flags riba-adjacent and divination terms for review', () => {
    for (const t of ['Payday cash advance comparison', 'Buy-now-pay-later credit card tips', 'Tarot readings', 'Vape review blog']) {
      assert.equal(screen(t), 'REVIEW_REQUIRED', t);
    }
  });
  it('checks target audience text when supplied', () => {
    const r = screenForHalalCompliance('Tips', 'x', 'Education', 'Info', 'Sales', 'Gambling addicts');
    assert.equal(r.status, 'NOT_ALLOWED');
  });
});

describe('halal filter: no substring false positives', () => {
  it('allows benign words that merely contain a flagged substring', () => {
    for (const t of ['Hamilton history worksheets', 'Shampoo ingredient guide', 'Class 11 Java project templates', 'Sussex travel notes']) {
      assert.equal(screen(t), 'HALAL', t);
    }
  });
});
