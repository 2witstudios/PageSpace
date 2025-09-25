import { redirect } from "next/navigation";

export default function AccountRedirectPage() {
  redirect("/settings/account");
}
