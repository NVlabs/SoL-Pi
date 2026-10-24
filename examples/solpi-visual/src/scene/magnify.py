#!/usr/bin/env python3
"""Deterministic, read-only source crop + conventional interpolation. No model calls."""
import argparse,hashlib,io,json,math,os,pathlib,stat,tempfile
from PIL import Image,ImageOps
VERSION='magnify-v1'
MAX_SOURCE_BYTES=64*1024*1024
MAX_OUTPUT_BYTES=3_750_000
def digest(b):return hashlib.sha256(b).hexdigest()
def read_source(path):
 if not path.is_file():raise ValueError('source must be a regular file')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NONBLOCK',0))
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno())
  if not stat.S_ISREG(info.st_mode):raise ValueError('source must be a regular file')
  if info.st_size>MAX_SOURCE_BYTES:raise ValueError('source exceeds64MiB')
  raw=stream.read(MAX_SOURCE_BYTES+1)
 if len(raw)>MAX_SOURCE_BYTES:raise ValueError('source exceeds64MiB')
 return raw
def extract(path,bbox,scale,method,max_side=1024):
 p=pathlib.Path(path).resolve(strict=True);raw=read_source(p)
 with Image.open(io.BytesIO(raw),formats=['PNG','JPEG']) as opened:
  if getattr(opened,'n_frames',1)!=1:raise ValueError('Use a single existing frame, not an animation')
  if opened.width*opened.height>32_000_000:raise ValueError('source exceeds32millionpixels')
  orientation=opened.getexif().get(274,1);im=ImageOps.exif_transpose(opened);im.load()
  if im.mode not in ('RGB','RGBA','L','LA'):raise ValueError('Use an existing RGB/RGBA/L/LA PNG/JPEG frame')
  w,h=im.size;x0,y0,x1,y1=bbox
  if not(0<=x0<x1<=w and 0<=y0<y1<=h):raise ValueError('bbox must be nonempty and inside displayed image; no silent clamping')
  ow,oh=round((x1-x0)*scale),round((y1-y0)*scale)
  if ow<1 or oh<1 or max(ow,oh)>max_side or ow*oh>8_000_000:raise ValueError('output exceeds max-side/8MP or is empty; reduce bbox or scale')
  crop=im.crop(bbox)
  if crop.size!=(ow,oh):crop=crop.resize((ow,oh),resample=getattr(Image.Resampling,method.upper()))
  out=io.BytesIO();crop.save(out,format='PNG');data=out.getvalue()
  if len(data)>MAX_OUTPUT_BYTES:raise ValueError('PNG exceeds3750000bytes; reduce bbox or scale')
 return data,dict(source_path=str(p),source_sha256=digest(raw),source_bytes=len(raw),source_size=[w,h],exif_orientation=orientation,coordinate_space='EXIF-oriented displayed pixel edges; origin top-left; bbox right/bottom exclusive',bbox=list(bbox),requested_scale=scale,max_side=max_side,actual_scale=[ow/(x1-x0),oh/(y1-y0)],output_size=[ow,oh],interpolation=method,output_sha256=digest(data),mapping='original_x=x0+crop_x/actual_scale_x; original_y=y0+crop_y/actual_scale_y; pixel-edge coordinates',source_unchanged=read_source(p)==raw)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--image',required=True);ap.add_argument('--bbox',nargs=4,type=int,required=True,metavar=('X0','Y0','X1','Y1'));ap.add_argument('--scale',type=float,default=2);ap.add_argument('--interpolation',choices=['nearest','bilinear','bicubic','lanczos'],default='bicubic');ap.add_argument('--max-side',type=int,default=1024);ap.add_argument('--output-root',required=True);ap.add_argument('--reference');ap.add_argument('--reference-bbox',nargs=4,type=int);a=ap.parse_args()
 if not 1<=a.max_side<=4096:ap.error('max-side must be between1and4096')
 if not math.isfinite(a.scale) or not 1<=a.scale<=8:ap.error('scale must be finite and between1and8')
 if bool(a.reference)!=bool(a.reference_bbox):ap.error('--reference and --reference-bbox must be supplied together; do not assume identical framing')
 assets={};data,meta=extract(a.image,a.bbox,a.scale,a.interpolation,a.max_side);assets['crop']=(data,meta)
 if a.reference:assets['reference_crop']=extract(a.reference,a.reference_bbox,a.scale,a.interpolation,a.max_side)
 identity=dict(version=VERSION,tool_sha256=digest(pathlib.Path(__file__).read_bytes()),images={k:v[1] for k,v in assets.items()})
 key=digest(json.dumps(identity,sort_keys=True,separators=(',',':')).encode());root=pathlib.Path(a.output_root).resolve();root.mkdir(parents=True,exist_ok=True);target=root/key
 receipt=dict(identity,artifact_id=key,global_image_unchanged=True,evaluation_unchanged=True,synthetic_content=False,creates_new_detail=False,images={k:dict(v[1],output_path=str(target/(k+'.png'))) for k,v in assets.items()})
 encoded=(json.dumps(receipt,indent=2,sort_keys=True)+'\n').encode()
 def verify_existing():
  if (target/'RECEIPT.json').read_bytes()!=encoded or any(digest((target/(k+'.png')).read_bytes())!=v[1]['output_sha256'] for k,v in assets.items()):raise ValueError('Existing artifact differs; refusing overwrite')
 if target.exists():
  verify_existing()
  cached=True
 else:
  temp=pathlib.Path(tempfile.mkdtemp(prefix='.magnify-',dir=root))
  try:
   for k,v in assets.items():(temp/(k+'.png')).write_bytes(v[0])
   (temp/'RECEIPT.json').write_bytes(encoded)
   try:
    os.rename(temp,target);cached=False
   except OSError:
    if not target.is_dir():raise
    verify_existing();cached=True
  finally:
   if temp.exists():
    for child in temp.iterdir():child.unlink()
    temp.rmdir()
 print(json.dumps(dict(artifact_id=key,receipt=str(target/'RECEIPT.json'),cached=cached,images={k:{f:v for f,v in m.items() if f in ['output_path','source_sha256','bbox','actual_scale','output_size','coordinate_space']} for k,m in receipt['images'].items()})))
if __name__=='__main__':main()
