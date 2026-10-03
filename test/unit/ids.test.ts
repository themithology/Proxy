import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, parseType, parseLanguages } from '../../src/util/ids.js';

test('parseId recognises IMDB ids', () => {
  assert.deepEqual(parseId('tt0111161'), { imdbId: 'tt0111161' });
  assert.deepEqual(parseId('imdb:tt0111161').imdbId, 'tt0111161');
  assert.deepEqual(parseId('TT0111161').imdbId, 'tt0111161');
});

test('parseId recognises TMDB ids', () => {
  assert.deepEqual(parseId('278'), { tmdbId: '278', numeric: 278 });
  assert.deepEqual(parseId('tmdb:278'), { tmdbId: '278', numeric: 278 });
});

test('parseId keeps other prefixes', () => {
  assert.deepEqual(parseId('kitsu:123'), { native: { prefix: 'kitsu', value: '123' } });
  assert.deepEqual(parseId('direct:abc'), { native: { prefix: 'direct', value: 'abc' } });
});

test('parseId rejects junk', () => {
  assert.deepEqual(parseId(''), {});
  assert.deepEqual(parseId('   '), {});
});

test('parseType normalises aliases', () => {
  assert.equal(parseType('movie'), 'movie');
  assert.equal(parseType('tv'), 'series');
  assert.equal(parseType('show'), 'series');
  assert.equal(parseType('series'), 'series');
  assert.equal(parseType('anime'), 'anime');
  assert.equal(parseType('MOVIE'), 'movie');
});

test('parseLanguages splits and normalises', () => {
  assert.deepEqual(parseLanguages('hi,en'), ['hi', 'en']);
  assert.deepEqual(parseLanguages('HI, EN'), ['hi', 'en']);
  assert.deepEqual(parseLanguages('hi en ta'), ['hi', 'en', 'ta']);
  assert.deepEqual(parseLanguages(undefined), []);
  assert.deepEqual(parseLanguages(['hi', 'en']), ['hi', 'en']);
});
