import { handleRequest } from '../server/index.js';

export const config = { maxDuration: 60 };

export default async function vercelApiHandler(req, res) {
  await handleRequest(req, res);
}
