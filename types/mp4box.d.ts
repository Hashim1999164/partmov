declare module "mp4box" {
  export type MP4Info = {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    fragment_duration?: number;
    mime: string;
    tracks: Array<{
      id: number;
      type: string;
      codec: string;
      movie_duration?: number;
      track_width?: number;
      track_height?: number;
      audio?: { sample_rate: number; channel_count: number };
    }>;
  };

  export type MP4File = {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((msg: string) => void) | null;
    onSegment:
      | ((
          id: number,
          user: unknown,
          buffer: ArrayBuffer,
          sampleNum: number,
          is_last: boolean,
        ) => void)
      | null;
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    flush(): void;
    start(): void;
    stop(): void;
    seek(time: number, useRap?: boolean): { offset: number; time: number };
    setSegmentOptions(
      id: number,
      user: unknown,
      options?: { nbSamples?: number; rapAlignement?: boolean },
    ): void;
    unsetSegmentOptions(id: number): void;
    initializeSegmentation(): Array<{ id: number; user: unknown; buffer: ArrayBuffer }>;
    getInfo(): MP4Info;
  };

  export function createFile(keepMdatData?: boolean): MP4File;
}
