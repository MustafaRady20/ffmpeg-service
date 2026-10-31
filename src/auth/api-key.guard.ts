import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export const API_KEY_HEADER = 'x-api-key';
export const MIN_API_KEY_LENGTH = 32;

const IS_PUBLIC = 'isPublic';
/** Marks a route as reachable without an API key (e.g. health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

// Hashing both sides first gives equal-length buffers, so timingSafeEqual
// never throws and the comparison doesn't leak the key length.
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected = digest(process.env.COMPRESSOR_API_KEY ?? '');

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header(API_KEY_HEADER);
    if (!provided || !timingSafeEqual(digest(provided), this.expected)) {
      throw new UnauthorizedException('Missing or invalid API key');
    }
    return true;
  }
}
