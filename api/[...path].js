import { handleRequest } from '../server/index.js';

export default function vercelApiHandler(req, res) {
  return handleRequest(req, res);
}
