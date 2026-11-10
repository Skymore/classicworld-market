import { useLocation } from "react-router-dom";
import { usePageReady } from "../components/shared";
import WorkspaceTab from "../client/workspace";

/** /client/sweep and /client/account: the collector window's own tabs (see client/host.ts). */
export default function Client() {
  usePageReady();
  const account = useLocation().pathname.replace(/\/$/, "").endsWith("/account");
  return <WorkspaceTab tab={account ? "account" : "sweep"} />;
}
