// wgr-shim: Firefox's accelerated-canvas path tessellator (wpf-gpu-raster,
// vendored unmodified except for two counters), exposed to Node as wasm.
//
// Input: a flat f32 list of subpaths, [n, x0, y0, x1, y1, ... , n, ...],
// device pixels, filled NONZERO (canvas2d's default). Every subpath is closed,
// which is what fill() does implicitly.
// Output: the number of OutputVertex (12 bytes each) that DrawTargetWebgl
// would upload into its shared path vertex buffer, plus how many of the
// rasteriser's outputs were simple trapezoids and how many were per-scanline
// "complex scans" (the slow path).
use wpf_gpu_raster::{FillMode, PathBuilder};

static mut INPUT: Vec<f32> = Vec::new();

#[no_mangle]
pub extern "C" fn input_ptr(n: u32) -> *mut f32 {
    unsafe {
        let v = &mut *std::ptr::addr_of_mut!(INPUT);
        v.clear();
        v.resize(n as usize, 0.0);
        v.as_mut_ptr()
    }
}

#[no_mangle]
pub extern "C" fn raster(n: u32, clip_w: i32, clip_h: i32) -> u32 {
    let data = unsafe { &*std::ptr::addr_of!(INPUT) };
    let data = &data[..n as usize];
    let mut p = PathBuilder::new();
    p.set_fill_mode(FillMode::Winding);
    let mut i = 0usize;
    while i < data.len() {
        let k = data[i] as usize;
        i += 1;
        if k == 0 { continue; }
        p.move_to(data[i], data[i + 1]);
        for j in 1..k {
            p.line_to(data[i + 2 * j], data[i + 2 * j + 1]);
        }
        p.close();
        i += 2 * k;
    }
    wpf_gpu_raster::wgr_stats::reset();
    let out = p.rasterize_to_tri_list(0, 0, clip_w, clip_h);
    out.len() as u32
}

#[no_mangle]
pub extern "C" fn trapezoids() -> u32 { wpf_gpu_raster::wgr_stats::traps() }
#[no_mangle]
pub extern "C" fn complex_scans() -> u32 { wpf_gpu_raster::wgr_stats::scans() }

// Strokes: aa-stroke, the way DrawTargetWebgl's GenerateStrokeVertexBuffer
// drives it.  Input: [n, closed, x0, y0, ...] per subpath; lineWidth, butt
// caps, miter joins, miterLimit 10 -- canvas2d's defaults.  Points are
// quantised to WGR's 28.4 fixed point first, as Firefox does (the stroke is
// generated from the cached QuantizedPath).
#[no_mangle]
pub extern "C" fn stroke(n: u32, width: f32) -> u32 {
    use aa_stroke::{Stroker, StrokeStyle, LineCap, LineJoin, Point};
    let data = unsafe { &*std::ptr::addr_of!(INPUT) };
    let data = &data[..n as usize];
    let q = |v: f32| ((v - 0.5) * 16.0).round() / 16.0 + 0.5;
    let mut s = Stroker::new(&StrokeStyle { width, cap: LineCap::Butt, join: LineJoin::Miter, miter_limit: 10.0 });
    let mut i = 0usize;
    while i < data.len() {
        let k = data[i] as usize;
        let closed = data[i + 1] != 0.0;
        i += 2;
        if k == 0 { continue; }
        s.move_to(Point::new(q(data[i]), q(data[i + 1])), closed);
        for j in 1..k {
            let p = Point::new(q(data[i + 2 * j]), q(data[i + 2 * j + 1]));
            if j + 1 == k && !closed { s.line_to_capped(p); } else { s.line_to(p); }
        }
        if closed { s.close(); }
        i += 2 * k;
    }
    s.finish().len() as u32
}
