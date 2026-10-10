import { NextResponse } from "next/server";
import { homeDir } from "@/lib/home-dir";

export async function GET() {
  return NextResponse.json({ home: homeDir() });
}
