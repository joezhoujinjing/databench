export function isV2RoutePath(pathname: string): boolean {
  return pathname === '/v2' || pathname.startsWith('/v2/')
}
