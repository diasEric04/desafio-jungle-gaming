import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Marks an endpoint as open (health, metrics): the AuthGuard lets it through without identity. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
