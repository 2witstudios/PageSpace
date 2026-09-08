import { notFound } from "next/navigation";
import { StoreScreenshot } from "@/components/StoreScreenshot";
import { DEVICES, SHOTS, type ShotDevice } from "@/lib/app-store-shots";

export function generateStaticParams() {
  return DEVICES.flatMap((device) => SHOTS.map((shot) => ({ device, slug: shot.slug })));
}

export default async function ScreenshotRoute({
  params,
}: {
  params: Promise<{ device: string; slug: string }>;
}) {
  const { device, slug } = await params;
  const shot = SHOTS.find((s) => s.slug === slug);
  if (!shot || !DEVICES.includes(device as ShotDevice)) notFound();

  return <StoreScreenshot shot={shot} device={device as ShotDevice} />;
}
