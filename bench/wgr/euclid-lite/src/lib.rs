// euclid-lite: the handful of euclid 0.22 items aa-stroke uses, f32 only.
// Firefox vendors the real euclid; this avoids fetching it and num-traits for
// three structs.  Semantics follow euclid (try_normalize: None only at zero).
use std::ops::{Add, Sub, Mul, Div, Neg, AddAssign, SubAssign, DivAssign};
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Point2D<T> { pub x: T, pub y: T }
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Vector2D<T> { pub x: T, pub y: T }
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Transform2D<T> { pub m11: T, pub m12: T, pub m21: T, pub m22: T, pub m31: T, pub m32: T }
pub mod default {
    pub type Point2D<T> = super::Point2D<T>;
    pub type Vector2D<T> = super::Vector2D<T>;
    pub type Transform2D<T> = super::Transform2D<T>;
}
impl Point2D<f32> {
    pub const fn new(x: f32, y: f32) -> Self { Point2D { x, y } }
    pub fn to_vector(self) -> Vector2D<f32> { Vector2D { x: self.x, y: self.y } }
}
impl Vector2D<f32> {
    pub const fn new(x: f32, y: f32) -> Self { Vector2D { x, y } }
    pub fn length(self) -> f32 { (self.x * self.x + self.y * self.y).sqrt() }
    pub fn square_length(self) -> f32 { self.x * self.x + self.y * self.y }
    pub const fn zero() -> Self { Vector2D { x: 0.0, y: 0.0 } }
    // euclid 0.22: None only for an exactly zero length
    pub fn try_normalize(self) -> Option<Self> { let l = self.length(); if l == 0.0 { None } else { Some(Vector2D { x: self.x / l, y: self.y / l }) } }
    pub fn normalize(self) -> Self { let l = self.length(); Vector2D { x: self.x / l, y: self.y / l } }
    pub fn dot(self, o: Self) -> f32 { self.x * o.x + self.y * o.y }
    pub fn cross(self, o: Self) -> f32 { self.x * o.y - self.y * o.x }
    pub fn to_point(self) -> Point2D<f32> { Point2D { x: self.x, y: self.y } }
}
impl Sub for Point2D<f32> { type Output = Vector2D<f32>; fn sub(self, o: Self) -> Vector2D<f32> { Vector2D { x: self.x - o.x, y: self.y - o.y } } }
impl Add<Vector2D<f32>> for Point2D<f32> { type Output = Self; fn add(self, o: Vector2D<f32>) -> Self { Point2D { x: self.x + o.x, y: self.y + o.y } } }
impl Sub<Vector2D<f32>> for Point2D<f32> { type Output = Self; fn sub(self, o: Vector2D<f32>) -> Self { Point2D { x: self.x - o.x, y: self.y - o.y } } }
impl AddAssign<Vector2D<f32>> for Point2D<f32> { fn add_assign(&mut self, o: Vector2D<f32>) { self.x += o.x; self.y += o.y; } }
impl SubAssign<Vector2D<f32>> for Point2D<f32> { fn sub_assign(&mut self, o: Vector2D<f32>) { self.x -= o.x; self.y -= o.y; } }
impl Add for Vector2D<f32> { type Output = Self; fn add(self, o: Self) -> Self { Vector2D { x: self.x + o.x, y: self.y + o.y } } }
impl Sub for Vector2D<f32> { type Output = Self; fn sub(self, o: Self) -> Self { Vector2D { x: self.x - o.x, y: self.y - o.y } } }
impl Mul<f32> for Vector2D<f32> { type Output = Self; fn mul(self, s: f32) -> Self { Vector2D { x: self.x * s, y: self.y * s } } }
impl Neg for Vector2D<f32> { type Output = Self; fn neg(self) -> Self { Vector2D { x: -self.x, y: -self.y } } }
impl AddAssign for Vector2D<f32> { fn add_assign(&mut self, o: Self) { self.x += o.x; self.y += o.y; } }
impl Div<f32> for Vector2D<f32> { type Output = Self; fn div(self, s: f32) -> Self { Vector2D { x: self.x / s, y: self.y / s } } }
impl DivAssign<f32> for Vector2D<f32> { fn div_assign(&mut self, s: f32) { self.x /= s; self.y /= s; } }
