export type BridgeConfig = {
  port: number;
  relayUrl: string;
  relayInputSampleRate: number;
  relayOutputSampleRate: number;
  commitSilenceMs: number;
  vadThreshold: number;
  publicBaseUrl?: string;
  twilioWebhookPath: string;
  outboundStatusCallback?: string;
  apiToken?: string;
  twilioValidation?: boolean;
};

export type TwilioStartEvent = {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
};

export type TwilioMediaEvent = {
  event: "media";
  streamSid: string;
  media: {
    payload: string;
    track?: string;
    chunk?: number;
    timestamp?: number;
  };
};

export type TwilioStopEvent = {
  event: "stop";
  streamSid: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
};

export type TwilioMarkEvent = {
  event: "mark";
  streamSid: string;
  mark: {
    name: string;
  };
};

export type TwilioDtmfEvent = {
  event: "dtmf";
  streamSid: string;
  dtmf: {
    digits: string;
  };
};

export type TwilioEvent =
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent
  | TwilioMarkEvent
  | TwilioDtmfEvent
  | { event: string; [key: string]: unknown };
