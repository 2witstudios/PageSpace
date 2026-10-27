import { pageMetadata } from "@/lib/metadata";
import { isEmbedded, type LegalSearchParams } from "@/lib/legal-embed";
import { SubprocessorsDocument } from "./SubprocessorsDocument";

export const metadata = pageMetadata.subprocessors;

export default async function Page({ searchParams }: { searchParams: LegalSearchParams }) {
  return <SubprocessorsDocument embed={await isEmbedded(searchParams)} />;
}
