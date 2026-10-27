/** Read-only device frame. Device addresses and executable paths stay in main. */
export interface LanePreviewFrame {
  status: "connected" | "unavailable";
  laneId: string;
  laneName: string;
  instance: number | null;
  requestId?: string;
  gameId?: string;
  capturedAt?: string;
  imageDataUrl?: string;
  message: string;
}
