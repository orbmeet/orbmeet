/**
 * The three people on the landing film's call. One small WebGL renderer draws
 * each in turn and copies the result to that person's tile, so the tiles stay
 * ordinary elements the film can move around.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from "three";

const SIZE = 480;

interface Look {
  phase: number;
  skin: number;
  neck: number;
  nose: number;
  shirt: number;
  hair: number;
  backdrop: number;
  style: "long" | "bun" | "short";
}

const LOOKS: Look[] = [
  { phase: 0, skin: 0xe9b08c, neck: 0xd59a78, nose: 0xdc9f7c, shirt: 0xf4efe6, hair: 0x4a2416, backdrop: 0x9fd8bf, style: "long" },
  { phase: 1.7, skin: 0x9c6239, neck: 0x875330, nose: 0x8f5832, shirt: 0x2d1c82, hair: 0x141018, backdrop: 0xc4b8f5, style: "bun" },
  { phase: 3.1, skin: 0xcf9468, neck: 0xb98055, nose: 0xc38a5f, shirt: 0x26262d, hair: 0x201a26, backdrop: 0xf3c98a, style: "short" },
];

interface Person {
  root: Group;
  head: Group;
  eyes: Mesh[];
  mouth: Mesh;
  backdrop: Color;
  time: number;
  open: number;
}

const material = (color: number) => new MeshStandardMaterial({ color: new Color(color), roughness: 0.7, metalness: 0 });
const ball = (radius: number, color: number) => new Mesh(new SphereGeometry(radius, 48, 36), material(color));

function addHair(head: Group, look: Look): void {
  const cap = ball(0.8, look.hair);
  const [capHeight, capY, capZ] = look.style === "short" ? [0.56, 0.62, -0.14] : look.style === "bun" ? [0.7, 0.5, -0.22] : [0.72, 0.5, -0.2];
  cap.scale.set(0.96, capHeight, 0.98);
  cap.position.set(0, capY, capZ);
  head.add(cap);
  if (look.style === "long") {
    const back = ball(0.82, look.hair);
    back.scale.set(1.04, 1.5, 0.62);
    back.position.set(0, -0.3, -0.5);
    head.add(back);
  }
  if (look.style === "bun") {
    const bun = ball(0.3, look.hair);
    bun.position.set(0, 1.18, -0.36);
    head.add(bun);
  }
}

function makePerson(scene: Scene, look: Look): Person {
  const root = new Group();
  const head = new Group();

  const body = ball(1.5, look.shirt);
  body.scale.set(1.32, 1.02, 0.72);
  body.position.y = -2.72;
  root.add(body);

  const neck = new Mesh(new CylinderGeometry(0.25, 0.3, 0.8, 28), material(look.neck));
  neck.position.y = -0.98;
  root.add(neck);

  const skull = ball(0.78, look.skin);
  skull.scale.set(0.88, 1.12, 0.9);
  head.add(skull);

  const eyes = [-0.235, 0.235].map((x) => {
    const eye = ball(0.058, 0x17131c);
    eye.position.set(x, 0.1, 0.655);
    head.add(eye);
    return eye;
  });
  [-0.235, 0.235].forEach((x, side) => {
    const brow = new Mesh(new BoxGeometry(0.2, 0.04, 0.05), material(look.hair));
    brow.position.set(x, 0.3, 0.65);
    brow.rotation.z = side ? -0.08 : 0.08;
    head.add(brow);
  });

  const nose = ball(0.07, look.nose);
  nose.scale.set(0.8, 1.2, 0.9);
  nose.position.set(0, -0.1, 0.69);
  head.add(nose);

  const mouth = ball(0.11, 0x8a3a40);
  mouth.scale.set(1.25, 0.12, 0.35);
  mouth.position.set(0, -0.42, 0.62);
  head.add(mouth);

  [-0.69, 0.69].forEach((x) => {
    const ear = ball(0.11, look.skin);
    ear.position.set(x, -0.02, 0);
    head.add(ear);
  });

  addHair(head, look);
  root.add(head);
  root.position.y = 0.05;
  root.visible = false;
  scene.add(root);
  return { root, head, eyes, mouth, backdrop: new Color(look.backdrop), time: look.phase, open: 0 };
}

export interface FilmPeople {
  /** `speaker` is the index of whoever is talking, or -1 for nobody. */
  draw: (now: number, speaker: number) => void;
  dispose: () => void;
}

/** Null when the device has no WebGL; the tiles keep their initials. */
export function startFilmPeople(tiles: HTMLCanvasElement[], recording: HTMLCanvasElement): FilmPeople | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);

  const scene = new Scene();
  // Physically based lights: the π keeps the soft look these values were tuned for.
  scene.add(new HemisphereLight(0xffffff, 0xa89cc0, 0.72 * Math.PI));
  const key = new DirectionalLight(0xfff6ec, 0.95 * Math.PI);
  key.position.set(3, 4.5, 5.5);
  scene.add(key);
  const rim = new DirectionalLight(0xdfe6ff, 0.35 * Math.PI);
  rim.position.set(-4.5, 1.5, -1.5);
  scene.add(rim);

  const camera = new PerspectiveCamera(24, 1, 0.1, 50);
  camera.position.set(0, -0.1, 10.2);
  camera.lookAt(0, -0.55, 0);

  const people = LOOKS.map((look) => makePerson(scene, look));
  const contexts = tiles.map((canvas) => canvas.getContext("2d"));
  const recordingContext = recording.getContext("2d");
  let last = performance.now();

  return {
    draw(now, speaker) {
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;
      const clock = now / 1000;
      people.forEach((person, index) => {
        person.time += elapsed;
        const talking = speaker === index;
        const target = talking ? 0.55 + 0.45 * Math.abs(Math.sin(clock * 11 + index) * Math.sin(clock * 3.7 + index * 2)) : 0;
        person.open += (target - person.open) * Math.min(1, elapsed * 18);
        person.mouth.scale.y = 0.12 + person.open * 0.72;
        person.head.rotation.y = Math.sin(person.time * 0.7) * 0.14 + (talking ? Math.sin(person.time * 2.3) * 0.05 : 0);
        person.head.rotation.x = Math.sin(person.time * 0.53) * 0.04 + (talking ? Math.sin(person.time * 3.1) * 0.045 : 0);
        person.head.rotation.z = Math.sin(person.time * 0.41) * 0.04;
        person.root.position.y = 0.05 + Math.sin(person.time * 1.1) * 0.018;
        const blink = Math.sin(person.time * 1.3 + index) > 0.992 ? 0.1 : 1;
        person.eyes.forEach((eye) => {
          eye.scale.y = blink;
        });

        person.root.visible = true;
        scene.background = person.backdrop;
        renderer.render(scene, camera);
        person.root.visible = false;
        contexts[index]?.drawImage(renderer.domElement, 0, 0, SIZE, SIZE);
        if (index === 0) recordingContext?.drawImage(renderer.domElement, 0, 0, SIZE, SIZE);
      });
    },
    dispose() {
      scene.traverse((object) => {
        if (object instanceof Mesh) {
          object.geometry.dispose();
          (object.material as MeshStandardMaterial).dispose();
        }
      });
      renderer.dispose();
    },
  };
}
