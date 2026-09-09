import { initLiveTonnetz } from './panels/liveTonnetz.js';

const host = document.getElementById('live-tonnetz');
if (!host) throw new Error('live Tonnetz host is missing');
initLiveTonnetz(host);
