export function RoomMock() {
  return (
    <div className="room">
      <div className="room__bar">
        <span className="room__who">
          <span className="dot dot--copper" aria-hidden="true" />
          Ayla is holding the remote
        </span>
        <span className="room__who">
          <span className="dot" aria-hidden="true" />
          Both connected &middot; in sync within 40 ms
        </span>
      </div>
      <div className="room__stage">
        <p className="room__caption">&ldquo;We have all the time in the world.&rdquo;</p>
      </div>
      <div className="room__controls">
        <span>Pause for both</span>
        <span className="room__track" aria-hidden="true">
          <span className="room__played" />
          <span className="room__buffered" />
        </span>
        <span className="mono">00:48:12 / 02:07:33</span>
        <span>Subtitles: English</span>
      </div>
    </div>
  );
}
