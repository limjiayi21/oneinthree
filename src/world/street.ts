/**
 * The block: one Lower-East-Side-ish street at night, built procedurally.
 * See src/contracts.ts for the coordinate system; layout.ts for the fixed
 * positions of every landmark, point and zone.
 */

import * as THREE from 'three';
import type { Engine, Rect, StreetWorld } from '../contracts';
import { Builder, Pen, mulberry32, type MatKey } from './geo';
import { createTextures, type StreetTextures } from './textures';
import { GlowSystem, createSky, createSkyline, createSteam } from './fx';
import { buildRow, randomLot, randomRow, type Lot, type RowEnv } from './facades';
import { ground } from './ground';
import { alley, home, shop, sidewalkShed, subwayEntrance, sub } from './landmarks';
import { bikeRack, drawCar, hydrant, mailbox, parkedCars, signPost, streetLamp, trafficSignal, trashPile, tree, type LampHandle, type SignalHandle } from './props';
import {
  ALLEY,
  BLOCK_FAR,
  BLOCK_NEAR,
  BOUNDS,
  FRONT_FAR,
  FRONT_NEAR,
  HOME,
  LAMPS,
  LED,
  LINE,
  ROAD_HALF,
  ROAD_Y,
  SHED,
  SHOP,
  SODIUM,
  inRect,
  makePoints,
  makeZones,
  rect,
  type Ctx,
  type LightSite,
} from './layout';

const FOG_COLOR = 0x0f1b21;
const FOG_DENSITY = 0.0152;
const SIDE = 64;

function makeMaterials(T: StreetTextures, envMap: THREE.Texture): Record<MatKey, THREE.Material> {
  T.asphaltRough.repeat.set(8 / 11, 8 / 11);
  T.asphaltNormal.repeat.set(8 / 3.2, 8 / 3.2);
  const asphalt = new THREE.MeshStandardMaterial({
    map: T.asphalt,
    roughnessMap: T.asphaltRough,
    normalMap: T.asphaltNormal,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    envMap,
    envMapIntensity: 0.9,
  });
  const sidewalk = new THREE.MeshStandardMaterial({ map: T.sidewalk, roughness: 0.6, metalness: 0, vertexColors: true });
  const brick = new THREE.MeshLambertMaterial({ map: T.brick, vertexColors: true });
  const matte = new THREE.MeshLambertMaterial({ map: T.atlas, vertexColors: true, alphaTest: 0.5 });
  const gloss = new THREE.MeshStandardMaterial({ map: T.atlas, vertexColors: true, roughness: 0.34, metalness: 0.25, envMap, envMapIntensity: 0.7 });
  const lit = new THREE.MeshBasicMaterial({ map: T.atlas, vertexColors: true });
  const decal = new THREE.MeshLambertMaterial({
    map: T.atlas,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  const puddle = new THREE.MeshStandardMaterial({
    color: 0x07090b,
    roughness: 0.2,
    metalness: 0,
    envMap,
    envMapIntensity: 1.6,
    transparent: true,
    opacity: 0.66,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fa8a6,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    envMap,
    envMapIntensity: 1.2,
  });
  return { asphalt, sidewalk, brick, matte, trim: matte, gloss, lit, decal, puddle, glass };
}

const CAST: MatKey[] = ['matte', 'gloss'];
const RECEIVE: MatKey[] = ['asphalt', 'sidewalk', 'brick', 'matte', 'trim', 'gloss', 'decal', 'puddle'];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createStreet(engine: Engine): StreetWorld {
  const { scene, renderer, camera } = engine;
  const group = new THREE.Group();
  group.name = 'street';

  const T = createTextures(renderer.capabilities.getMaxAnisotropy());
  const R = T.regions;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromEquirectangular(T.env);
  pmrem.dispose();
  const mats = makeMaterials(T, envTarget.texture);
  const fogColor = new THREE.Color(FOG_COLOR);
  const prevFog = scene.fog;
  const prevBackground = scene.background;
  scene.fog = new THREE.FogExp2(fogColor, FOG_DENSITY);
  scene.background = fogColor;

  const builder = new Builder();
  const pen = new Pen(builder, R.white);
  const rng = mulberry32(20241107);
  const colliders: Rect[] = [];
  const glow = new GlowSystem();
  const lights: LightSite[] = [];
  const ctx: Ctx = { pen, R, rng, colliders, glow, lights };
  const env: RowEnv = { pen, R, rng, colliders, glow: (x, y, z, size, color, intensity) => void glow.billboard(x, y, z, size, color, intensity) };

  const points = makePoints();
  const zones = makeZones();

  /* ================================================================ static */

  ground(ctx);

  /* ---- right-hand fronts: lots given by their z span ---- */
  const zl = (zA: number, zB: number, over: Partial<Lot> = {}): Lot => randomLot(rng, zB - FRONT_FAR, zA - zB, 0, { raise: 0, ...over });
  const shedLook: Partial<Lot> = { ground: 'plain', fireEscape: false, lit: 0, tint: 0x6c5448, trim: 0x5c5850, floors: 4, gh: 3.6, fh: 3.1, cornice: 1, tower: false };
  const homeLot = zl(HOME.z0, HOME.z1, {
    ground: 'none',
    gh: 3.7,
    fh: 3.1,
    floors: 3,
    tint: 0x80584a,
    trim: 0x8a8272,
    cornice: 2,
    fireEscape: false,
    lit: 0,
    forceLit: [[0, 1, 0], [1, 3, 2], [2, 0, 6]],
    tower: false,
  });
  const rightLots: Lot[] = [
    zl(FRONT_NEAR, -2.5, { ground: 'shutter', fireEscape: false, tint: 0x7d5a4e, floors: 4, cornice: 1, sign: 'sign_shop1' }),
    zl(-2.5, -10.5, { ground: 'door', entryLight: true, floors: 5 }),
    zl(-10.5, ALLEY.z0, { ground: 'shutter', sign: 'sign_shop0', floors: 4, lit: 0.05 }),
    zl(ALLEY.z1, -27.6, { ground: 'door', raise: 0.66, stoopDepth: 1.05, floors: 3, lit: 0.04 }),
    zl(-27.6, SHED.z0, { ground: 'door', floors: 5, lit: 0.05 }),
    zl(SHED.z0, -43, shedLook),
    zl(-43, SHED.z1, shedLook),
    zl(SHED.z1, -59.2, { ground: 'door', floors: 4 }),
    zl(-59.2, -66.5, { ground: 'door', floors: 3 }),
    zl(-66.5, SHOP.z0, { ground: 'shutter', sign: 'sign_shop1', floors: 5 }),
    zl(SHOP.z0, SHOP.z1, { ground: 'none', gh: 3.6, floors: 4, fireEscape: false, tint: 0x7f6a5c, trim: 0x756f62, cornice: 1, lit: 0.12, tower: true }),
    zl(SHOP.z1, -89.5, { ground: 'door', entryLight: true, floors: 4 }),
    zl(-89.5, -96.2, { ground: 'shutter', floors: 5 }),
    zl(-96.2, -103.4, { ground: 'door', raise: 0.72, stoopDepth: 1.2, floors: 3 }),
    zl(-103.4, -110, { ground: 'door', floors: 5 }),
    zl(-110, -117.2, { ground: 'door', raise: 0.72, stoopDepth: 1.2, floors: 4 }),
    zl(-117.2, HOME.z0, { ground: 'door', floors: 4, entryLight: false }),
    homeLot,
    zl(HOME.z1, FRONT_FAR, { ground: 'door', floors: 4, fireEscape: false, cornice: 1 }),
  ];
  buildRow(env, LINE, FRONT_FAR, -Math.PI / 2, rightLots);
  colliders.push(rect(LINE, 16, FRONT_NEAR, ALLEY.z0));
  colliders.push(rect(LINE, 16, ALLEY.z1, SHED.z0));
  colliders.push(rect(LINE - 0.1, 16, SHED.z0, SHED.z1));
  colliders.push(rect(LINE, 16, SHED.z1, SHOP.z0));
  colliders.push(rect(LINE, 16, SHOP.z1, FRONT_FAR));

  /* ---- left-hand fronts ---- */
  const leftLots = randomRow(rng, FRONT_NEAR - FRONT_FAR, 0);
  leftLots.forEach((l, i) => {
    l.raise = 0;
    if (l.ground === 'door' && i % 3 === 1) {
      l.raise = 0.54;
      l.stoopDepth = 1.0;
    }
    if (i % 5 === 2) l.entryLight = l.ground === 'door';
    if (l.ground === 'shutter' && i % 2 === 0) l.sign = i % 4 === 0 ? 'sign_shop0' : 'sign_shop1';
  });
  // a closed laundromat with a half-dead sign, across from the bodega's block
  const laundro = leftLots.find((l) => FRONT_NEAR - (l.u0 + l.w / 2) < -60 && FRONT_NEAR - (l.u0 + l.w / 2) > -72);
  if (laundro) Object.assign(laundro, { ground: 'shutter', raise: 0, sign: 'sign_laundro', signLit: true });
  buildRow(env, -LINE, FRONT_NEAR, Math.PI / 2, leftLots);
  colliders.push(rect(-16, -LINE, FRONT_NEAR, FRONT_FAR));

  /* ---- around the corners, across the cross streets, and the next blocks ---- */
  const shift = (lots: Lot[], d: number): Lot[] => lots.map((l) => ({ ...l, u0: l.u0 + d }));
  const side = (l: Lot, u0: number): Lot => ({ ...l, u0, w: 12, ground: 'door', raise: 0, fireEscape: false, entryLight: false, lod: 0, sign: undefined, forceLit: undefined, noParty: true, tower: false });
  const far = (len: number): Lot[] => randomRow(rng, len, 1).map((l) => ({ ...l, raise: 0 }));
  const run = SIDE - LINE - 12; // 43.5
  const nearLine = BLOCK_NEAR + 13, farLine = BLOCK_FAR - 13;
  const lastR = rightLots[rightLots.length - 1], lastL = leftLots[leftLots.length - 1];
  // near cross street, block side
  buildRow(env, LINE, FRONT_NEAR + 0.02, 0, [side(rightLots[0], 0), ...shift(far(run), 12)]);
  buildRow(env, -SIDE, FRONT_NEAR + 0.02, 0, [...far(run), side(leftLots[0], run)]);
  // far cross street, block side
  buildRow(env, SIDE, FRONT_FAR - 0.02, Math.PI, [...far(run), side(lastR, run)]);
  buildRow(env, -LINE, FRONT_FAR - 0.02, Math.PI, [side(lastL, 0), ...shift(far(run), 12)]);
  // opposite sides of both cross streets
  buildRow(env, SIDE, nearLine, Math.PI, far(SIDE - LINE));
  buildRow(env, -LINE, nearLine, Math.PI, far(SIDE - LINE));
  buildRow(env, LINE, farLine, 0, far(SIDE - LINE));
  buildRow(env, -SIDE, farLine, 0, far(SIDE - LINE));
  // the street carrying on beyond each end
  buildRow(env, LINE, nearLine, -Math.PI / 2, far(89));
  buildRow(env, -LINE, nearLine + 89, Math.PI / 2, far(89));
  buildRow(env, LINE, farLine - 97, -Math.PI / 2, far(97));
  buildRow(env, -LINE, farLine, Math.PI / 2, far(97));
  // the cross streets end in a T
  buildRow(env, SIDE, -7, -Math.PI / 2, far(39));
  buildRow(env, -SIDE, 32, Math.PI / 2, far(39));
  buildRow(env, SIDE, -165, -Math.PI / 2, far(39));
  buildRow(env, -SIDE, -126, Math.PI / 2, far(39));

  /* ---- landmarks ---- */
  const subway = subwayEntrance(ctx);
  const alleyInfo = alley(ctx);
  sidewalkShed(ctx);
  const shopInfo = shop(ctx);
  const homeInfo = home(ctx, homeLot);
  const metalRects: Rect[] = [...subway.metal, shopInfo.metal];

  /* ---- street furniture ---- */
  const lamps: LampHandle[] = LAMPS.map((l) => streetLamp(ctx, l.z, l.side, l.color, !!l.flicker));
  // beyond the block: glow only, no real light
  streetLamp(ctx, 36, 1, SODIUM, false, false);
  streetLamp(ctx, 62, -1, SODIUM, false, false);
  streetLamp(ctx, -166, 1, SODIUM, false, false);
  streetLamp(ctx, -192, -1, LED, false, false);
  for (const [x, z, col] of [[30, 12.5, SODIUM], [-34, 12.5, LED], [32, -144.5, SODIUM], [-30, -144.5, SODIUM]] as Array<[number, number, number]>) {
    pen.identity().to('matte', z).worldUV(0, 0).ao(1, 1).color(0x23262a);
    const pz = z > 0 ? BLOCK_NEAR - 0.4 : BLOCK_FAR + 0.4;
    pen.cyl(x, 0, pz, 0.1, 0.06, 7.6, 6, 0);
    pen.tube(x, 7.5, pz, x, 7.8, z, 0.045, 0.04, 5);
    glow.billboard(x, 7.7, z, 3.4, col, 0.5, 0.5);
    glow.billboard(x, 7.7, z, 0.75, col, 1.4, 0.45);
    glow.flat(x, ROAD_Y + 0.02, z, 22, 16, col, 0.16);
  }

  const carsR = parkedCars(ctx, 1, -1.5, -135, [[-16.5, -24.6], [-44.5, -48.5], [-75.2, -80.8], [-125.8, -130.4]]);
  const carsL = parkedCars(ctx, -1, 1, -135, [[-28, -33], [-46, -51], [-76, -81], [-100, -104]]);
  parkedCars(ctx, 1, 104, 24, [], false);
  parkedCars(ctx, -1, 104, 24, [], false);
  parkedCars(ctx, 1, -156, -244, [], false);
  parkedCars(ctx, -1, -156, -244, [], false);

  for (const z of [-14.5, -30, -56, -66.3, -92, -104.5, -119.5]) tree(ctx, 5.3, z);
  for (const z of [-5, -19, -44, -57, -71, -95, -108, -122]) tree(ctx, -5.3, z);
  for (const z of [40, 58, 83, -170, -188, -214]) {
    tree(ctx, 5.3, z, false);
    tree(ctx, -5.3, z - 9, false);
  }
  hydrant(ctx, 5.05, -20.3);
  hydrant(ctx, 5.05, -79.6);
  hydrant(ctx, -5.05, -30.5);
  hydrant(ctx, -5.05, -102);
  trashPile(ctx, 5.2, -12.2, 4, 0.35, 0.8);
  trashPile(ctx, 5.05, -25.6, 6, 0.28, 1.1);
  trashPile(ctx, 5.2, -63, 5, 0.35, 1.0);
  trashPile(ctx, 5.2, -72.4, 4, 0.35, 0.8);
  trashPile(ctx, 5.2, -87.6, 5, 0.35, 1.0);
  trashPile(ctx, 5.2, -121.8, 4, 0.35, 0.8);
  trashPile(ctx, -5.2, -15, 5, 0.35, 1.0);
  trashPile(ctx, -5.15, -53.5, 6, 0.3, 1.2);
  trashPile(ctx, -5.2, -80, 4, 0.35, 0.8);
  trashPile(ctx, -5.15, -112.5, 6, 0.3, 1.2);
  trashPile(ctx, -5.2, -127, 3, 0.3, 0.6);
  mailbox(ctx, 5.2, -100.6);
  bikeRack(ctx, 5.15, -69.6);
  signPost(ctx, 4.85, -27.9, 'sign_parking', 0.36, 0.48, 1);
  signPost(ctx, 4.85, -89.4, 'sign_parking', 0.36, 0.48, 1);
  signPost(ctx, 4.85, -115.4, 'sign_parking', 0.36, 0.48, 1);
  signPost(ctx, -4.85, -64.5, 'sign_parking', 0.36, 0.48, 1);
  signPost(ctx, -4.85, 2.2, 'sign_oneway', 0.9, 0.28, 1, 2.5);
  signPost(ctx, 4.85, -132.6, 'sign_oneway', 0.9, 0.28, 1, 2.5);

  const signals: SignalHandle[] = [
    trafficSignal(ctx, 5.05, -137.5, 1.3, 1, 5.05, 0),
    trafficSignal(ctx, -5.05, 5.8, -1.3, -1, 5.05, 17),
  ];

  // a car alarm LED or two, and someone's phone glowing in a parked car across the street
  const nearest = (cars: typeof carsR, z: number) => cars.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
  const alarmLeds: number[] = [];
  for (const car of [nearest(carsR, -10), nearest(carsL, -92), nearest(carsR, -106)]) {
    if (car.type === 'van') continue;
    alarmLeds.push(glow.billboard(car.x + 0.3, ROAD_Y + 0.97, car.z + car.nose * 1.0, 0.15, 0xff2010, 2.4, 0.04));
  }
  const phoneCar = nearest(carsL, -58);
  glow.billboard(phoneCar.x + 0.82, ROAD_Y + 1.15, phoneCar.z + phoneCar.nose * 0.15, 0.75, 0x7f9fc0, 0.1, 0.12);

  /* ---- passing car glows are allocated before the mesh is built ---- */
  const carGlow = {
    head: [glow.billboard(0, -50, 0, 1.3, 0xfff2dc, 1.15, 0.3), glow.billboard(0, -50, 0, 1.3, 0xfff2dc, 1.15, 0.3)],
    tail: [glow.billboard(0, -50, 0, 0.7, 0xff2a1a, 0.8, 0.25), glow.billboard(0, -50, 0, 0.7, 0xff2a1a, 0.8, 0.25)],
  };

  /* ================================================================ build */

  for (const m of builder.build(mats, { cast: CAST, receive: RECEIVE })) group.add(m);
  const glowMesh = glow.build(T.glow, FOG_DENSITY);
  group.add(glowMesh);
  const sky = createSky(fogColor);
  group.add(sky);
  const skyline = createSkyline(T.skyline);
  group.add(skyline);
  const steamTint = new THREE.Color(0x8c7c6a);
  const steam = createSteam(T.glow, -0.8, ROAD_Y + 0.05, -64, steamTint, fogColor, FOG_DENSITY);
  group.add(steam);

  /* ---- lights ---- */
  const hemi = new THREE.HemisphereLight(0x3d5f78, 0x1a1712, 1.0);
  group.add(hemi);
  const moon = new THREE.DirectionalLight(0x6f93b4, 0.22);
  moon.position.set(-30, 60, 20);
  group.add(moon);
  const pointLights = lights.map((s) => {
    const l = new THREE.PointLight(s.color, s.intensity, s.distance, 2);
    l.position.set(s.x, s.y, s.z);
    l.name = s.id;
    group.add(l);
    return l;
  });
  // a breath of fill travelling with the viewer, so a face at arm's length is never pure black
  // (it sits behind and above the eyes so the player's own hands are not over-lit)
  const fill = new THREE.PointLight(0x9fb6c8, 1.5, 8, 2);
  fill.position.set(0.25, 0.35, 1.2);
  camera.add(fill);

  // the one shadow-casting light: it stands in for whichever lamp the viewer is nearest to
  const key = new THREE.SpotLight(0xffffff, 0, 30, 1.25, 0.1, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.035;
  key.shadow.radius = 3.5;
  key.shadow.camera.near = 0.25;
  key.shadow.camera.far = 30;
  group.add(key, key.target);
  const shadowSites = lights.map((s, i) => ({ s, i })).filter((e) => e.s.shadow);
  let keySite = -1;
  const lightLevel = lights.map(() => 1);

  /* ================================================================ dynamic */

  /** Build a small standalone mesh set with the shared materials. */
  const sculpt = (draw: (p: Pen) => void): THREE.Mesh[] => {
    const b = new Builder();
    const p = new Pen(b, R.white);
    draw(p);
    const meshes = b.build(mats, { cast: CAST, receive: RECEIVE });
    for (const m of meshes) m.frustumCulled = true;
    return meshes;
  };
  const dynamicGeometries: THREE.BufferGeometry[] = [];
  const own = (meshes: THREE.Mesh[]): THREE.Mesh[] => {
    for (const m of meshes) dynamicGeometries.push(m.geometry);
    return meshes;
  };

  /* ---- doors ---- */
  const homeDoor = new THREE.Group();
  homeDoor.name = 'homeDoor';
  homeDoor.position.copy(homeInfo.hinge);
  homeDoor.add(
    ...own(
      sculpt((p) => {
        const w = homeInfo.leafWidth, h = homeInfo.leafHeight;
        p.toChunk('matte', 'd').color(0xffffff).ao(0.85, 1);
        p.rectZY(0, 0, w, h, 0, -1, R.door_home);
        p.color(0x2a1c14).ao(1, 1);
        p.rectZY(0, 0, w, h, 0.05, 1);
        p.boxMin(0, 0, 0, 0.05, h, w, 'xX');
        // the glazed panel glows with the hall light
        p.toChunk('lit', 'd').rgb(0.55, 0.55, 0.55);
        p.rectZY(w * 0.17, h * (1 - 0.565), w * 0.83, h * (1 - 0.089), -0.003, -1, sub(R.door_home, 0.17, 0.089, 0.83, 0.565));
      }),
    ),
  );
  group.add(homeDoor);

  const shopDoor = new THREE.Group();
  shopDoor.name = 'shopDoor';
  shopDoor.position.copy(shopInfo.hinge);
  shopDoor.add(
    ...own(
      sculpt((p) => {
        const w = shopInfo.leafWidth, h = shopInfo.leafHeight;
        p.toChunk('matte', 'd').color(0x5a5e62).ao(1, 1);
        p.boxMin(-0.02, 0, 0, 0.045, h, 0.07);
        p.boxMin(-0.02, 0, w - 0.07, 0.045, h, 0.07);
        p.boxMin(-0.02, 0, 0, 0.045, 0.2, w);
        p.boxMin(-0.02, h - 0.09, 0, 0.045, 0.09, w);
        p.boxMin(-0.045, 1.0, 0.07, 0.03, 0.05, w - 0.14);
        p.boxMin(0.04, 1.0, 0.07, 0.03, 0.05, w - 0.14);
        p.toChunk('glass', 'd').color(0xffffff);
        p.rectZY(0.07, 0.2, w - 0.07, h - 0.09, 0, -1);
        p.rectZY(0.07, 0.2, w - 0.07, h - 0.09, 0.005, 1);
      }),
    ),
  );
  group.add(shopDoor);

  const doors = {
    home: { node: homeDoor, open: 0, target: 0, angle: (80 * Math.PI) / 180 },
    shop: { node: shopDoor, open: 1, target: 1, angle: (96 * Math.PI) / 180 },
  };
  const applyDoors = (): void => {
    for (const d of [doors.home, doors.shop]) {
      const t = d.open * d.open * (3 - 2 * d.open);
      d.node.rotation.y = t * d.angle;
    }
  };
  const setShopColliders = (open: boolean): void => {
    const dc = shopInfo.doorCollider, lc = shopInfo.leafCollider;
    const z0 = SHOP.doorZ - SHOP.doorHalf, z1 = SHOP.doorZ + SHOP.doorHalf;
    if (open) {
      Object.assign(dc, rect(1000, 1000.01, 1000, 1000.01));
      Object.assign(lc, rect(LINE + 0.26, LINE + 1.42, z0 - 0.14, z0 + 0.02));
    } else {
      Object.assign(dc, rect(LINE, LINE + 0.26, z0, z1));
      Object.assign(lc, rect(1000, 1000.01, 1001, 1001.01));
    }
  };
  applyDoors();
  setShopColliders(true);

  /* ---- alley: trash can, lid, cat ---- */
  const CAN_R = 0.27, CAN_H = 0.76;
  const canPivot = new THREE.Group(); // sits on the can's base edge, street side
  canPivot.name = 'trashCan';
  const canBody = new THREE.Group();
  canBody.position.set(CAN_R, 0, 0);
  canBody.add(
    ...own(
      sculpt((p) => {
        p.toChunk('gloss', 'd').color(0x70767b).ao(0.7, 1);
        p.cyl(0, 0, 0, 0.25, CAN_R + 0.02, CAN_H, 14, 1);
        p.color(0x565b60).ao(1, 1);
        for (const y of [0.18, 0.4, 0.62]) p.cyl(0, y, 0, 0.262 + y * 0.03, 0.264 + y * 0.03, 0.035, 14, 0);
        p.cyl(0, CAN_H - 0.03, 0, CAN_R + 0.03, CAN_R + 0.03, 0.035, 14, 0);
        p.color(0x08090a).disc(0, CAN_H - 0.06, 0, CAN_R, 14, 1);
        p.color(0x3a3d40).box(0, 0.5, CAN_R + 0.02, 0.14, 0.03, 0.04).box(0, 0.5, -CAN_R - 0.02, 0.14, 0.03, 0.04);
      }),
    ),
  );
  canPivot.add(canBody);
  group.add(canPivot);
  const canLid = new THREE.Group();
  canLid.add(
    ...own(
      sculpt((p) => {
        p.toChunk('gloss', 'd').color(0x666c71).ao(1, 1);
        p.cyl(0, 0, 0, CAN_R + 0.05, CAN_R + 0.05, 0.045, 14, 3);
        p.cyl(0, 0.045, 0, CAN_R, 0.09, 0.06, 14, 2);
        p.color(0x3a3d40).box(0, 0.125, 0, 0.14, 0.035, 0.035);
      }),
    ),
  );
  group.add(canLid);

  const cat = new THREE.Group();
  cat.name = 'cat';
  cat.visible = false;
  const catBody = new THREE.Group();
  catBody.add(
    ...own(
      sculpt((p) => {
        const FUR = 0x57514a;
        p.toChunk('matte', 'd').color(FUR).ao(1, 1);
        p.box(0, 0.25, -0.02, 0.12, 0.13, 0.4);
        p.box(0, 0.262, 0.13, 0.135, 0.15, 0.16);
        p.box(0, 0.335, 0.27, 0.115, 0.105, 0.12);
        p.box(0, 0.31, 0.34, 0.06, 0.05, 0.05);
        p.box(-0.04, 0.405, 0.265, 0.03, 0.05, 0.02).box(0.04, 0.405, 0.265, 0.03, 0.05, 0.02);
        p.tube(0, 0.29, -0.2, 0, 0.36, -0.36, 0.022, 0.018, 5);
        p.color(0x2c2925).tube(0, 0.36, -0.36, 0, 0.5, -0.44, 0.018, 0.01, 5);
        // tabby bands across the back
        for (const z of [-0.14, -0.04, 0.06]) p.box(0, 0.317, z, 0.122, 0.006, 0.035);
        p.toChunk('lit', 'd').rgb(0.7, 1.2, 0.45);
        p.rectXY(-0.042, 0.338, -0.018, 0.352, 0.331).rectXY(0.018, 0.338, 0.042, 0.352, 0.331);
      }),
    ),
  );
  cat.add(catBody);
  const legGeo = own(
    sculpt((p) => {
      p.toChunk('matte', 'd').color(0x4d4841).box(0, -0.1, 0, 0.035, 0.21, 0.042).box(0, -0.2, 0.015, 0.035, 0.025, 0.06);
    }),
  )[0].geometry;
  const catLegs: THREE.Mesh[] = [];
  for (const [x, z] of [[-0.045, 0.14], [0.045, 0.14], [-0.045, -0.16], [0.045, -0.16]]) {
    const leg = new THREE.Mesh(legGeo, mats.matte);
    leg.position.set(x, 0.21, z);
    catBody.add(leg);
    catLegs.push(leg);
  }
  group.add(cat);

  const catPath = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(10.7, 0, -19.95),
      new THREE.Vector3(9.3, 0, -19.75),
      new THREE.Vector3(8.2, 0, -20.05),
      new THREE.Vector3(6.6, 0, -21.3),
      new THREE.Vector3(5.0, 0, -22.9),
      new THREE.Vector3(3.9, ROAD_Y, -24.6),
      new THREE.Vector3(3.5, ROAD_Y, -26.2),
    ],
    false,
    'centripetal',
  );
  const canHome = new THREE.Vector3(alleyInfo.can.x - CAN_R, 0, alleyInfo.can.z);
  const canRest = rect(alleyInfo.can.x - 0.32, alleyInfo.can.x + 0.32, alleyInfo.can.z - 0.32, alleyInfo.can.z + 0.32);
  const alleyState = { t: -1, colliderMoved: false };
  const _v = new THREE.Vector3();
  const _t = new THREE.Vector3();

  const poseAlley = (t: number): void => {
    // t < 0: untouched
    const FALL = 0.42;
    let theta = 0, slide = 0, rollZ = 0;
    if (t > 0) {
      if (t < FALL) {
        theta = (Math.PI / 2) * Math.pow(t / FALL, 2.2);
      } else {
        const u = t - FALL;
        theta = Math.PI / 2 - 0.2 * Math.abs(Math.sin((u * Math.PI) / 0.2)) * Math.exp(-u * 7);
        slide = 0.16 * (1 - Math.exp(-u * 5));
        rollZ = 0.5 * (1 - Math.exp(-u * 1.9));
      }
    }
    canPivot.position.set(canHome.x - slide, 0, canHome.z + rollZ);
    canPivot.rotation.set(0, 0, theta);
    canBody.rotation.y = rollZ / CAN_R;

    // lid: rides the can until it hits the ground, then skids off and rings down
    if (t < FALL) {
      canLid.position.set(canHome.x + CAN_R * Math.cos(theta) - CAN_H * Math.sin(theta), CAN_R * Math.sin(theta) + CAN_H * Math.cos(theta), canHome.z);
      canLid.rotation.set(0, 0, theta);
    } else {
      const u = t - FALL;
      const k = 1 - Math.exp(-u * 3.2);
      const hop = Math.max(0, 0.34 * Math.sin(Math.min(1, u / 0.36) * Math.PI));
      const wob = Math.exp(-u * 2.6);
      canLid.position.set(canHome.x - CAN_H - 0.04 - 1.15 * k, 0.03 + hop + 0.12 * wob, canHome.z - 0.5 * k);
      canLid.rotation.set(Math.sin(u * 19) * 0.6 * wob, u * 4 * wob, (Math.PI / 2) * wob + Math.cos(u * 19) * 0.6 * wob * (1 - wob));
    }

    poseCat(t, catPath);
  };

  /** The cat on `path` at time t of a dash (it bolts at CAT_START and is gone after CAT_RUN). */
  const CAT_START = 0.12, CAT_RUN = 1.06;
  const poseCat = (t: number, path: THREE.Curve<THREE.Vector3>): void => {
    const ct = (t - CAT_START) / CAT_RUN;
    if (t < 0 || ct <= 0 || ct >= 1) {
      cat.visible = false;
    } else {
      cat.visible = true;
      const e = 1 - Math.pow(1 - ct, 1.5); // bolts, then eases under the car
      path.getPoint(e, _v);
      path.getTangent(e, _t);
      const phase = ct * CAT_RUN * 5.4 * Math.PI * 2;
      cat.position.copy(_v);
      cat.rotation.y = Math.atan2(_t.x, _t.z);
      catBody.position.y = 0.035 * Math.abs(Math.sin(phase)) - 0.02 * e;
      catBody.rotation.x = Math.sin(phase) * 0.16;
      const swing = 0.95;
      catLegs[0].rotation.x = Math.sin(phase) * swing;
      catLegs[1].rotation.x = Math.sin(phase + 0.5) * swing;
      catLegs[2].rotation.x = Math.sin(phase + Math.PI) * swing;
      catLegs[3].rotation.x = Math.sin(phase + Math.PI + 0.5) * swing;
    }
  };
  poseAlley(-1);
  /** A cat-only dash somewhere other than the alley (t < 0: not running). */
  const dashState: { t: number; path: THREE.Curve<THREE.Vector3> | null } = { t: -1, path: null };

  /* ---- passing car ---- */
  const car = new THREE.Group();
  car.name = 'passingCar';
  car.visible = false;
  car.add(...own(sculpt((p) => drawCar(p, R, 'sedan', 0x4f5357, 0, 0, 0, 0, true, 0))));
  const headlight = new THREE.SpotLight(0xfff0d8, 0, 62, 0.52, 0.75, 2);
  headlight.position.set(0, 0.74, 2.0);
  headlight.target.position.set(0, -0.35, 16);
  car.add(headlight, headlight.target);
  group.add(car);
  const carState = { active: false, dir: 1 as 1 | -1, z: 0, speed: 0, x: 0 };
  const CAR_SPEED = 10.5;
  /** The car appears and vanishes this far either side of mid-block, deep in the fog beyond the block ends. */
  const CAR_RUN = 140;
  const HEAD_CD = 1100;
  const hideCarGlow = (): void => {
    for (const id of [...carGlow.head, ...carGlow.tail]) {
      glow.setLevel(id, 0);
      glow.setPosition(id, 0, -50, 0);
    }
  };
  hideCarGlow();

  /* ---- flicker, signals, alarms ---- */
  const flick = { next: 2.5, t: -1, pattern: [] as Array<[number, number]> };
  const lampLevel = (elapsed: number, dt: number): number => {
    // an ageing LED head: steady, with an occasional stutter (never a strobe)
    if (flick.t < 0) {
      if (elapsed >= flick.next) {
        flick.t = 0;
        const n = rng() < 0.5 ? 1 : 2;
        flick.pattern = [];
        let at = 0;
        for (let i = 0; i < n; i++) {
          const len = 0.07 + rng() * 0.09;
          flick.pattern.push([at, at + len]);
          at += len + 0.16 + rng() * 0.12;
        }
      }
      return 0.97 + 0.03 * Math.sin(elapsed * 31);
    }
    flick.t += dt;
    let level = 1;
    let done = true;
    for (const [a, b] of flick.pattern) {
      if (flick.t < b) done = false;
      if (flick.t >= a && flick.t < b) level = 0.38;
    }
    if (done) {
      flick.t = -1;
      flick.next = elapsed + 3 + rng() * 6;
    }
    return level;
  };

  const SIGNAL_PERIOD = 46;
  const signalState = signals.map(() => -1);
  const SIGNAL_COLORS = [0xff2a1a, 0xffb020, 0x30ff9a];
  const updateSignals = (elapsed: number): void => {
    signals.forEach((s, i) => {
      const ph = (elapsed + s.offset) % SIGNAL_PERIOD;
      const state = ph < 21 ? 2 : ph < 24.5 ? 1 : 0; // index into SIGNAL_COLORS: 2 green, 1 yellow, 0 red
      if (state === signalState[i]) return;
      signalState[i] = state;
      s.cores.forEach((id, k) => glow.setLevel(id, k === state ? 1 : 0.02));
      glow.setColor(s.halo, SIGNAL_COLORS[state], 0.3);
      glow.setColor(s.pool, SIGNAL_COLORS[state], 0.06);
      if (state === 2) glow.setColor(s.ped, 0xe8eeff, 1.4);
      else glow.setColor(s.ped, 0xff7a1a, 1.6);
    });
  };
  // cores were created dark: give them their colours, then let updateSignals pick the live one
  signals.forEach((s) => {
    glow.setColor(s.cores[0], SIGNAL_COLORS[0], 3.0);
    glow.setColor(s.cores[1], SIGNAL_COLORS[1], 3.0);
    glow.setColor(s.cores[2], SIGNAL_COLORS[2], 2.6);
  });
  updateSignals(0);

  const camPos = new THREE.Vector3();

  const updateKeyLight = (): void => {
    camera.getWorldPosition(camPos);
    let best = -1, d1 = Infinity, d2 = Infinity;
    for (let k = 0; k < shadowSites.length; k++) {
      const s = shadowSites[k].s;
      const d = Math.hypot(s.x - camPos.x, s.z - camPos.z);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best = k;
      } else if (d < d2) {
        d2 = d;
      }
    }
    let w = 0;
    if (best >= 0) w = smooth(0.94, 0.62, d1 / Math.max(d2, 0.001)) * smooth(26, 15, d1);
    // hand the role over only while the key is faded out, so shadows never jump
    if (best >= 0 && best !== keySite && (key.intensity === 0 || keySite < 0)) {
      keySite = best;
      const s = shadowSites[best].s;
      const low = s.y < 5;
      key.position.set(s.x, s.y, s.z);
      // low fixtures lean their cone toward the walking line so walls and faces stay inside it
      key.target.position.set(low ? s.x + (s.x > 7.2 ? -0.7 : 0.8) : s.x, 0, s.z);
      key.target.updateMatrixWorld();
      key.color.setHex(s.color);
      key.angle = low ? 1.3 : 1.25;
      key.penumbra = low ? 0.2 : 0.1;
      key.distance = s.distance;
      key.shadow.camera.far = s.distance;
      key.shadow.needsUpdate = true;
    }
    for (let k = 0; k < shadowSites.length; k++) {
      const { s, i } = shadowSites[k];
      const share = k === keySite ? 0.8 * w : 0;
      pointLights[i].intensity = s.intensity * lightLevel[i] * (1 - share);
      if (k === keySite) {
        key.intensity = best === keySite ? s.intensity * lightLevel[i] * share : 0;
        key.shadow.intensity = 1;
      }
    }
  };

  /* ================================================================ api */

  let disposed = false;

  const world: StreetWorld = {
    group,
    colliders,
    bounds: BOUNDS,
    points,
    zones,

    update(dt: number, elapsed: number): void {
      if (disposed) return;
      (steam.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;

      // flickering lamp
      const level = lampLevel(elapsed, dt);
      for (const l of lamps) {
        if (!l.flicker) continue;
        glow.setLevel(l.halo, level);
        glow.setLevel(l.core, level);
        glow.setLevel(l.pool, level);
        if (l.lightIndex >= 0) lightLevel[l.lightIndex] = level;
      }
      updateSignals(elapsed);
      const blink = elapsed % 1.7 < 0.11 ? 1 : 0;
      for (const id of alarmLeds) glow.setLevel(id, blink);

      // doors: ~0.6 s swing
      for (const d of [doors.home, doors.shop]) {
        if (d.open !== d.target) {
          const step = dt / 0.6;
          d.open = d.target > d.open ? Math.min(d.target, d.open + step) : Math.max(d.target, d.open - step);
        }
      }
      applyDoors();

      // alley event
      if (alleyState.t >= 0) {
        alleyState.t += dt;
        poseAlley(alleyState.t);
        if (!alleyState.colliderMoved && alleyState.t > 2.2) {
          alleyState.colliderMoved = true;
          const px = canPivot.position.x, pz = canPivot.position.z;
          Object.assign(alleyInfo.canCollider, rect(px - CAN_H - 0.05, px + 0.05, pz - CAN_R - 0.04, pz + CAN_R + 0.04));
        }
        if (alleyState.t > 6) alleyState.t = 6; // settled; keep the final pose
      }
      if (dashState.t >= 0 && dashState.path) {
        dashState.t += dt;
        poseCat(dashState.t, dashState.path);
        if (dashState.t > CAT_START + CAT_RUN) dashState.t = -1; // gone (poseCat has hidden it)
      }

      // passing car
      if (carState.active) {
        camera.getWorldPosition(camPos);
        // brake for someone standing in the lane
        let target = CAR_SPEED;
        const ahead = (camPos.z - carState.z) * carState.dir;
        if (Math.abs(camPos.x - carState.x) < 1.9 && ahead > 0 && ahead < 26) target = Math.max(0, (ahead - 6.5) * 0.9);
        const rate = target < carState.speed ? 9 : 2.6;
        carState.speed += Math.sign(target - carState.speed) * Math.min(Math.abs(target - carState.speed), rate * dt);
        carState.z += carState.dir * carState.speed * dt;
        car.position.set(carState.x, ROAD_Y, carState.z);
        const fwd = carState.dir;
        const hz = carState.z + fwd * 2.22, tz = carState.z - fwd * 2.22;
        glow.setPosition(carGlow.head[0], carState.x - 0.59, ROAD_Y + 0.62, hz);
        glow.setPosition(carGlow.head[1], carState.x + 0.59, ROAD_Y + 0.62, hz);
        glow.setPosition(carGlow.tail[0], carState.x - 0.63, ROAD_Y + 0.76, tz);
        glow.setPosition(carGlow.tail[1], carState.x + 0.63, ROAD_Y + 0.76, tz);
        // fade the lamps in and out at the ends of the run so nothing pops
        const edge = smooth(CAR_RUN, CAR_RUN - 18, Math.abs(carState.z + 66));
        headlight.intensity = HEAD_CD * edge;
        for (const id of carGlow.head) glow.setLevel(id, edge);
        for (const id of carGlow.tail) glow.setLevel(id, edge * (target < carState.speed - 0.01 ? 2.2 : 1));
        if (carState.dir * (carState.z + 66) > CAR_RUN + 2) {
          carState.active = false;
          car.visible = false;
          headlight.intensity = 0;
          hideCarGlow();
        }
      }

      updateKeyLight();
    },

    setDoorOpen(which: 'home' | 'shop', open: boolean): void {
      doors[which].target = open ? 1 : 0;
      if (which === 'shop') setShopColliders(open);
    },

    triggerAlleyEvent(): void {
      // replayable: put the can back first
      Object.assign(alleyInfo.canCollider, canRest);
      alleyState.colliderMoved = false;
      alleyState.t = 0;
      poseAlley(0);
    },

    triggerCatDash(path: THREE.Vector3[]): void {
      dashState.path = new THREE.CatmullRomCurve3(path, false, 'centripetal');
      dashState.t = 0;
      poseCat(0, dashState.path);
    },

    spawnPassingCar(direction: 1 | -1): void {
      if (carState.active) return;
      carState.active = true;
      carState.dir = direction;
      carState.x = direction > 0 ? -0.75 : 0.75;
      carState.z = -66 - direction * CAR_RUN;
      carState.speed = CAR_SPEED;
      car.rotation.y = direction > 0 ? 0 : Math.PI;
      car.position.set(carState.x, ROAD_Y, carState.z);
      car.visible = true;
    },

    surfaceAt(x: number, z: number): 'concrete' | 'asphalt' | 'metal' | 'tile' {
      if (inRect(shopInfo.interior, x, z)) return 'tile';
      for (const m of metalRects) if (inRect(m, x, z)) return 'metal';
      if (Math.abs(x) < ROAD_HALF || z > BLOCK_NEAR || z < BLOCK_FAR) return 'asphalt';
      return 'concrete';
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      camera.remove(fill);
      scene.fog = prevFog;
      scene.background = prevBackground;
      const seen = new Set<THREE.BufferGeometry>();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !seen.has(m.geometry)) {
          seen.add(m.geometry);
          m.geometry.dispose();
        }
      });
      for (const g of dynamicGeometries) g.dispose();
      for (const m of Object.values(mats)) m.dispose();
      glow.material?.dispose();
      (sky.material as THREE.Material).dispose();
      (skyline.material as THREE.Material).dispose();
      (steam.material as THREE.Material).dispose();
      key.shadow.dispose();
      key.dispose();
      for (const l of pointLights) l.dispose();
      envTarget.dispose();
      T.dispose();
    },
  };

  scene.add(group);
  return world;
}
