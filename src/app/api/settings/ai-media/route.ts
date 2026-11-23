import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { encrypt } from "@/lib/whatsapp/encryption";
import {
  AI_MEDIA_AUDIO_PROVIDERS,
  AI_MEDIA_IMAGE_PROVIDERS,
  type AiAudioProvider,
  type AiImageProvider,
} from "@/lib/flows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FilaMedia {
  image_provider: AiImageProvider;
  image_api_key: string | null;
  image_model: string | null;
  audio_provider: AiAudioProvider;
  audio_api_key: string | null;
  audio_model: string | null;
  default_voice: string;
}

function publica(fila: FilaMedia | null) {
  return {
    image_provider: fila?.image_provider ?? "pollinations",
    image_model: fila?.image_model ?? "flux",
    audio_provider: fila?.audio_provider ?? "edge",
    audio_model: fila?.audio_model ?? "gpt-4o-mini-tts",
    default_voice: fila?.default_voice ?? "es-MX-DaliaNeural",
    has_image_api_key: Boolean(fila?.image_api_key),
    has_audio_api_key: Boolean(fila?.audio_api_key),
  };
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { data, error } = await supabase
      .from("ai_media_configs")
      .select(
        "image_provider, image_api_key, image_model, audio_provider, audio_api_key, audio_model, default_voice",
      )
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json({ config: publica((data as FilaMedia | null) ?? null) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const body = (await request.json().catch(() => ({}))) as {
      image_provider?: string;
      image_api_key?: string;
      image_model?: string;
      audio_provider?: string;
      audio_api_key?: string;
      audio_model?: string;
      default_voice?: string;
    };

    if (
      body.image_provider &&
      !(AI_MEDIA_IMAGE_PROVIDERS as readonly string[]).includes(body.image_provider)
    ) {
      return NextResponse.json({ error: "invalid_image_provider" }, { status: 400 });
    }
    if (
      body.audio_provider &&
      !(AI_MEDIA_AUDIO_PROVIDERS as readonly string[]).includes(body.audio_provider)
    ) {
      return NextResponse.json({ error: "invalid_audio_provider" }, { status: 400 });
    }

    const { data: actual } = await supabase
      .from("ai_media_configs")
      .select("*")
      .eq("account_id", accountId)
      .maybeSingle();
    const fila = actual as FilaMedia | null;

    const patch: Record<string, unknown> = {
      account_id: accountId,
      image_provider: body.image_provider ?? fila?.image_provider ?? "pollinations",
      image_model: body.image_model ?? fila?.image_model ?? "flux",
      audio_provider: body.audio_provider ?? fila?.audio_provider ?? "edge",
      audio_model: body.audio_model ?? fila?.audio_model ?? "gpt-4o-mini-tts",
      default_voice: body.default_voice ?? fila?.default_voice ?? "es-MX-DaliaNeural",
      updated_at: new Date().toISOString(),
    };
    if (typeof body.image_api_key === "string" && body.image_api_key.trim()) {
      patch.image_api_key = encrypt(body.image_api_key.trim());
    }
    if (typeof body.audio_api_key === "string" && body.audio_api_key.trim()) {
      patch.audio_api_key = encrypt(body.audio_api_key.trim());
    }

    const { error } = await supabase
      .from("ai_media_configs")
      .upsert(patch, { onConflict: "account_id" });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
