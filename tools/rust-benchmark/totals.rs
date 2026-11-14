use std::{env,fs::File,io::{self,Read}};
fn main()->io::Result<()> {
 let mut f=File::open(env::args().nth(1).expect("data path"))?;let mut buf=vec![0u8;32*65536];let(mut calls,mut input,mut output,mut read,mut write)=(0u64,0u64,0u64,0u64,0u64);let mut cost=0f64;
 loop {let mut n=0;while n<buf.len(){let k=f.read(&mut buf[n..])?;if k==0{break} n+=k;}if n==0{break}if n%32!=0{return Err(io::Error::new(io::ErrorKind::InvalidData,"partial record"))}for x in buf[..n].chunks_exact(32){calls+=1;input+=u32::from_le_bytes(x[0..4].try_into().unwrap()) as u64;output+=u32::from_le_bytes(x[4..8].try_into().unwrap()) as u64;read+=u32::from_le_bytes(x[8..12].try_into().unwrap()) as u64;write+=u32::from_le_bytes(x[12..16].try_into().unwrap()) as u64;cost+=f64::from_le_bytes(x[16..24].try_into().unwrap());}}
 println!("{{\"calls\":{calls},\"input\":{input},\"output\":{output},\"cacheRead\":{read},\"cacheWrite\":{write},\"cost\":{cost}}}");Ok(())
}
