/* Verifies your Bunny Stream credentials: lists the library and creates + deletes a throwaway video record. */
import { BunnyVideoProvider } from '../lib/video.js';
import { config } from '../config.js';

if (!(config.BUNNY_LIBRARY_ID && config.BUNNY_API_KEY && config.BUNNY_CDN_HOSTNAME)) {
  console.error('Set BUNNY_LIBRARY_ID, BUNNY_API_KEY and BUNNY_CDN_HOSTNAME in apps/api/.env first.'); process.exit(1);
}
const b = new BunnyVideoProvider();
try {
  await b.ping(); console.log('✓ API key and library ID are valid');
  const { providerVideoId, upload } = await b.createUpload({ title: 'twiqo connectivity check' });
  console.log(`✓ created a test video (${providerVideoId}) and a ${upload.type.toUpperCase()} upload signature`);
  await b.remove({ id: 'check', provider: 'bunny', provider_video_id: providerVideoId }); console.log('✓ deleted the test video');
  console.log('Playback URL pattern:', b.urls({ id: 'x', provider: 'bunny', provider_video_id: '<video-id>' }).hls);
  console.log('\nLast step: in the Bunny dashboard add a webhook to  <your API>/api/videos/webhook/bunny?secret=<BUNNY_WEBHOOK_SECRET>');
} catch (e) { console.error('✗', (e as Error).message); process.exit(1); }
