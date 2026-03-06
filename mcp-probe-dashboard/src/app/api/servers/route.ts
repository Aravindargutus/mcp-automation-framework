import { NextResponse } from 'next/server';
import { listServers, addServer, removeServer } from '@/lib/server-store';

export async function GET() {
  return NextResponse.json(listServers());
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.name || !body.transport?.type) {
    return NextResponse.json({ error: 'name and transport.type are required' }, { status: 400 });
  }
  addServer(body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name query param required' }, { status: 400 });
  }
  const removed = removeServer(name);
  return NextResponse.json({ ok: removed });
}
