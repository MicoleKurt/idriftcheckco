import assert from 'node:assert';
import { slugify } from './src/slugify.js';
assert.equal(slugify('  Hello   World  '), 'hello-world');
