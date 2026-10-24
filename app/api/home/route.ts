import { NextResponse } from "vinext/shims/server";
import { homeDir } from "@/lib/home-dir";

export async function GET() {
  return NextResponse.json({ home: homeDir() });
}
