import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER = process.env.BASIC_AUTH_USERNAME;
const PASS = process.env.BASIC_AUTH_PASSWORD;

export function middleware(request: NextRequest) {
  if (!USER || !PASS) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Authentication required.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Voice Bridge"' },
    });
  }

  const base64Credentials = authHeader.split(' ')[1];
  const decoded = Buffer.from(base64Credentials, 'base64').toString();
  const [username, password] = decoded.split(':');

  if (username === USER && password === PASS) {
    return NextResponse.next();
  }

  return new Response('Invalid credentials.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Voice Bridge"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
