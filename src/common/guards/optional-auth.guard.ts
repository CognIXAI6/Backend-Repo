import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard for endpoints accessible to both guests and authenticated users.
 *
 * When a valid JWT is present the user object is attached to the request as
 * normal.  When the token is missing or invalid the request is still allowed
 * through — request.user will simply be undefined.
 *
 * Usage:
 *   @UseGuards(OptionalAuthGuard)
 *   async someEndpoint(@CurrentUser() user?: AuthUser) { ... }
 */
@Injectable()
export class OptionalAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest(_err: any, user: any) {
    // Swallow errors — unauthenticated requests are allowed
    return user ?? null;
  }
}
