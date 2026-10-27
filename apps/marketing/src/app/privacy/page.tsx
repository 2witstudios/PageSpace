import { pageMetadata } from "@/lib/metadata";
import { isEmbedded, type LegalSearchParams } from "@/lib/legal-embed";
import { PrivacyDocument } from "./PrivacyDocument";

export const metadata = pageMetadata.privacy;

export default async function Page({ searchParams }: { searchParams: LegalSearchParams }) {
  return <PrivacyDocument embed={await isEmbedded(searchParams)} />;
}
