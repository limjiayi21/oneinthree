/**
 * Only one head look at a time: while the AirPods are tracking, the camera head look is switched off
 * (no face tracking, no badge), and when they stop it comes back if it was wanted. Turning the camera
 * on (body mode, ?eyes=1, G) while the AirPods track is remembered for afterwards rather than done now.
 * Hand tracking also uses the camera and is not affected.
 */

interface Camera {
  readonly state: string;
  enable(): Promise<void>;
  disable(): void;
}

interface AirPods {
  readonly state: string;
  onChange(cb: () => void): () => void;
}

export interface HeadLookArbiter {
  /** Turn the camera head look on, or, while the AirPods track, once they stop. */
  enableCamera(): void;
  /** G: on/off as before; while the AirPods track it only changes what happens after them. */
  toggleCamera(): void;
  dispose(): void;
}

export function createHeadLookArbiter(camera: Camera, airpods: AirPods): HeadLookArbiter {
  const tracking = () => airpods.state === 'on';
  /** Whether the camera head look should be on whenever the AirPods are not tracking. */
  let wanted = false;
  let wasTracking = tracking();

  const off = airpods.onChange(() => {
    const now = tracking();
    if (now === wasTracking) return;
    wasTracking = now;
    if (now) {
      if (camera.state !== 'off') wanted = true;
      camera.disable();
    } else if (wanted && camera.state === 'off') {
      void camera.enable();
    }
  });

  return {
    enableCamera() {
      wanted = true;
      if (!tracking()) void camera.enable();
    },
    toggleCamera() {
      if (tracking()) {
        wanted = !wanted;
        return;
      }
      if (camera.state === 'off' || camera.state === 'error') {
        wanted = true;
        void camera.enable();
      } else {
        wanted = false;
        camera.disable();
      }
    },
    dispose: off,
  };
}
