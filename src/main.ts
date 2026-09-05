import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  const http = app.getHttpAdapter().getInstance() as { set?: (k: string, v: unknown) => void };
  http.set?.('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const feOrigin = config.get<string>('FE_ORIGIN', 'http://localhost:3001');
  const origins = feOrigin
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

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`Enshido_BE listening on http://localhost:${port}/api`);
}
bootstrap();
