import { pageMetadata } from "@/lib/metadata";
import { isEmbedded, type LegalSearchParams } from "@/lib/legal-embed";
import { TermsDocument } from "./TermsDocument";

export const metadata = pageMetadata.terms;

export default async function Page({ searchParams }: { searchParams: LegalSearchParams }) {
  return <TermsDocument embed={await isEmbedded(searchParams)} />;
}
