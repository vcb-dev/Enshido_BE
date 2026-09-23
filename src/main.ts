import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: false }));
  // Gzip JSON: 25 dòng danh sách đơn ~29 KB còn ~3 KB.
  app.use(compression());
  app.use(cookieParser());
  const http = app.getHttpAdapter().getInstance() as {
    set?: (k: string, v: unknown) => void;
  };
  http.set?.('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:3001');
  const origins = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
  });

  if (config.get<string>('NODE_ENV') === 'production') {
    app.getHttpAdapter().getInstance().disable('x-powered-by');
  }

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`Enshido_BE listening on http://localhost:${port}/api`);
}
bootstrap();
