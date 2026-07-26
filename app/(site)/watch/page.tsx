import type { Metadata } from "next";
import { WatchLobby } from "@/components/watch/WatchLobby";

export const metadata: Metadata = {
  title: "Watch together",
  description:
    "Start a private Partmov room and watch a free sample film with someone — invite link, shared play/pause, and soft drift correction.",
};

export default function WatchPage() {
  return <WatchLobby />;
}
