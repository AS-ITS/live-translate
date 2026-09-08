import { createCloudFoundationHandler } from '../server/cloudFoundation.js';

const handler = createCloudFoundationHandler();

export default function vercelApiHandler(req, res) {
  return handler(req, res);
}

