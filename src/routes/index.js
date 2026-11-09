import express from 'express';
import path from 'path';
import {fileURLToPath} from 'url';
import {createHealthController, info} from '../controllers/health.controller.js';
import {createAnalyzeController} from '../controllers/farming.controller.js';
import {createAuthMiddleware} from '../middlewares/auth.js';
import {createRateLimiter} from '../middlewares/rateLimiter.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export const createRoutes = ({config, runner, deviceData}) => {
  const router = express.Router();

  router.get('/health', createHealthController(runner));

  router.post(['/api/v1/farming/analyze', '/api/farming/analyze'],
    createAuthMiddleware(config), createRateLimiter(config), createAnalyzeController({config, runner, deviceData}));

  // test page (map uploader) - off by default in production
  if (config.serveTestPage) {
    router.use(express.static(publicDir));
  } else {
    router.get('/', info);
  }

  return router;
};
