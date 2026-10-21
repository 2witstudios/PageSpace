import { pageMetadata } from "@/lib/metadata";
import { isEmbedded, type LegalSearchParams } from "@/lib/legal-embed";
import { CookiesDocument } from "./CookiesDocument";

export const metadata = pageMetadata.cookies;

export default async function Page({ searchParams }: { searchParams: LegalSearchParams }) {
  return <CookiesDocument embed={await isEmbedded(searchParams)} />;
}
