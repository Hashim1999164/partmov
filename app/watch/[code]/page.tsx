import type { Metadata } from "next";
import { Suspense } from "react";
import { WatchRoomGate } from "@/components/watch/WatchRoomGate";

export const metadata: Metadata = {
  title: "Private room",
  description: "A private Partmov watch room with synchronised playback.",
};

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <Suspense
      fallback={
        <div className="shell watch-lobby">
          <p className="lede">Opening the room…</p>
        </div>
      }
    >
      <WatchRoomGate code={code} />
    </Suspense>
  );
}
