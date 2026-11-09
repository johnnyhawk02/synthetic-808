// Renders reference audio from the Rust voices in app/src for test/compare-rust.mjs.
// Needs synthetic-808 checked out next to this repo. Run from test/rust-reference:  cargo run --release  (writes ./out/*.bin)
#![allow(dead_code)]
#[path = "../../../../synthetic-808/app/src/params.rs"] mod params;
#[path = "../../../../synthetic-808/app/src/synth.rs"] mod synth;
#[path = "../../../../synthetic-808/app/src/bd.rs"] mod bd;
#[path = "../../../../synthetic-808/app/src/sd.rs"] mod sd;
#[path = "../../../../synthetic-808/app/src/tom.rs"] mod tom;
#[path = "../../../../synthetic-808/app/src/rs.rs"] mod rs;
#[path = "../../../../synthetic-808/app/src/cb.rs"] mod cb;
#[path = "../../../../synthetic-808/app/src/metal.rs"] mod metal;
#[path = "../../../../synthetic-808/app/src/cymbal.rs"] mod cymbal;
#[path = "../../../../synthetic-808/app/src/hats.rs"] mod hats;
use std::io::Write;
use std::sync::{Arc, atomic::AtomicU32};
use params::{Params, P};
use synth::{Engine, Voice, VOICES};

fn dump(name: &str, v: &[f64]) {
    let mut f = std::fs::File::create(format!("out/{name}.bin")).unwrap();
    for x in v { f.write_all(&x.to_le_bytes()).unwrap(); }
}

fn main() {
    std::fs::create_dir_all("out").unwrap();
    for sr in [48000.0f64, 44100.0] {
        let n = sr as usize;
        let tag = sr as u32;
        for vel in [1.0, 2.0] {
            let vt = vel as u32;
            let run = |f: &mut dyn FnMut(usize) -> f64| -> Vec<f64> { (0..n).map(|i| f(i)).collect() };
            let mut b = bd::BassDrum::new(sr);
            dump(&format!("bd_{tag}_{vt}"), &run(&mut |i| { if i == 100 { b.trigger(vel) } b.tick(0.3, 0.7, 0.6, 0.4, 0.8) }));
            let mut s = sd::Snare::new(sr);
            s.prepare(&sd::SnareKnobs { tone: 0.3, snappy: 0.7, decay: 0.6, ndec: 0.4, model_hi: vel == 1.0, color: 0.25 });
            dump(&format!("sd_{tag}_{vt}"), &run(&mut |i| { if i == 100 { s.trigger(vel) } s.tick(0.4, 0.6) }));
            for (k, spec) in [&tom::LOW, &tom::MID, &tom::HIGH].iter().enumerate() {
                let mut t = tom::Tom::new(spec, sr, 0x1111 * (k as u64 + 1));
                dump(&format!("tom{k}_{tag}_{vt}"), &run(&mut |i| { if i == 100 { t.trigger(vel, vel == 1.0) } t.tick(0.4, 0.6, 0.7, 0.3) }));
            }
            let mut r = rs::RimShot::new(sr);
            let rk = rs::RimKnobs { tune: 0.4, dec: 0.6, osc1: 0.3, osc2: 0.7, flt: 0.2, res: 0.6 };
            dump(&format!("rs_{tag}_{vt}"), &run(&mut |i| { if i == 100 { r.trigger(vel, vel == 1.0) } r.tick(&rk) }));
            let mk = metal::MetalKnobs { duty: 0.4, volt: 0.6, cb_pw: 0.3, cb_tune: 0.7, cb_o1: 0.45, cb_o2: 0.55, cb_from_hats: vel == 2.0 };
            let mut m = metal::Metal::new(sr);
            let mut c = cb::Cowbell::new(sr);
            let mut y = cymbal::Cymbal::new(sr);
            y.stretch = cymbal::stretch_for(0.6);
            let mut h = hats::Hats::new(sr);
            let (mut vc, mut vy, mut vh, mut vo, mut vm) = (vec![], vec![], vec![], vec![], vec![]);
            for i in 0..n {
                if i == 100 { c.trigger(vel); y.trigger(vel); h.trigger_closed(vel); }
                if i == 300 { h.trigger_open(vel); }
                let o = m.tick(&mk);
                vm.push(o.hi + o.lo * 3.0 + o.cb1 * 5.0 + o.cb2 * 7.0);
                vc.push(c.tick(o.cb1, o.cb2, 0.7, 0.4));
                vy.push(y.tick(o.hi, o.lo, 0.7, 0.3, 0.6));
                let (a, b2) = h.tick(o.hi, 0.4, 0.6);
                vh.push(a); vo.push(b2);
            }
            dump(&format!("metal_{tag}_{vt}"), &vm);
            dump(&format!("cb_{tag}_{vt}"), &vc);
            dump(&format!("cy_{tag}_{vt}"), &vy);
            dump(&format!("ch_{tag}_{vt}"), &vh);
            dump(&format!("oh_{tag}_{vt}"), &vo);
        }
    }
    // engine: every voice, default params plus alt switches, accented and not
    let sr = 48000.0f32;
    let cases: Vec<(String, Option<(P, f32)>, Voice, bool)> = {
        let mut c = vec![];
        for v in Voice::ALL { for acc in [false, true] { c.push((format!("eng_{:?}_{}", v, acc as u8), None, v, acc)); } }
        for (sw, v) in [(P::LtSw, Voice::LowTom), (P::RsSw, Voice::Rim), (P::HcSw, Voice::Clap), (P::CbSw, Voice::Cowbell)] {
            c.push((format!("eng_alt_{:?}", v), Some((sw, 1.0 - Params::default_of(sw))), v, false));
        }
        c
    };
    for (name, sw, v, acc) in cases {
        let p = Params::new();
        p.set(P::TrgVol, 0.5); p.set(P::AcLevel, 0.6); p.set(P::Drive, 0.3); p.set(P::MainVca, 1.0);
        if let Some((s, x)) = sw { p.set(s, x); }
        let meters: Arc<Vec<AtomicU32>> = Arc::new((0..VOICES).map(|_| AtomicU32::new(0)).collect());
        let mut e = Engine::new(sr, p, meters);
        e.trigger(v, acc);
        let mut buf = vec![0.0f32; 48000];
        let mut all = vec![];
        for blk in buf.chunks_mut(512) { e.render(blk, 1); all.extend(blk.iter().map(|x| *x as f64)); }
        dump(&name, &all);
    }
}
