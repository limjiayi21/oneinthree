import { describe, expect, it } from 'vitest';
import { createHeadLookArbiter } from './headLookArbiter';

/** Stand-ins: the webcam head look and the AirPods, with just what the arbiter uses. */
function setup() {
  const eyes = { state: 'off' as string, enable: async () => void (eyes.state = 'on'), disable: () => void (eyes.state = 'off') };
  let notify = () => {};
  const airpods = { state: 'off' as string, onChange: (cb: () => void) => ((notify = cb), () => {}) };
  const arb = createHeadLookArbiter(eyes, airpods);
  const setAirPods = (s: string) => {
    airpods.state = s;
    notify();
  };
  return { eyes, arb, setAirPods };
}

describe('camera head look stands down while the AirPods track', () => {
  it('turns the camera head look off when the AirPods start tracking', () => {
    const { eyes, arb, setAirPods } = setup();
    arb.enableCamera();
    expect(eyes.state).toBe('on');
    setAirPods('on');
    expect(eyes.state).toBe('off');
  });

  it('turns it back on when the AirPods stop, if it was on before', () => {
    const { eyes, arb, setAirPods } = setup();
    arb.enableCamera();
    setAirPods('on');
    setAirPods('waiting'); // out of the ears
    expect(eyes.state).toBe('on');
  });

  it('does not turn it on afterwards if it was never on', () => {
    const { eyes, setAirPods } = setup();
    setAirPods('on');
    setAirPods('nohelper');
    expect(eyes.state).toBe('off');
  });

  it('asking for the camera while the AirPods track (body mode, ?eyes=1) waits until they stop', () => {
    const { eyes, arb, setAirPods } = setup();
    setAirPods('on');
    arb.enableCamera();
    expect(eyes.state).toBe('off');
    setAirPods('off');
    expect(eyes.state).toBe('on');
  });

  it('G while the AirPods track only changes what happens after them', () => {
    const { eyes, arb, setAirPods } = setup();
    arb.enableCamera();
    setAirPods('on');
    arb.toggleCamera(); // "I don't want the camera"
    setAirPods('off');
    expect(eyes.state).toBe('off');
  });

  it('G with no AirPods toggles the camera head look as before', () => {
    const { eyes, arb } = setup();
    arb.toggleCamera();
    expect(eyes.state).toBe('on');
    arb.toggleCamera();
    expect(eyes.state).toBe('off');
  });
});
