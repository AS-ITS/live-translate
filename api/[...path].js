import { handleRequest } from '../server/index.js';

export const config = { maxDuration: 60 };

export default function vercelApiHandler(req, res) {
  return handleRequest(req, res);
}
