#include <algorithm>
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_3.h>
#include <wrl/client.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <string>
#include <sstream>
#include <iostream>
#include <deque>
#include <chrono>
#include <cmath>
#include <vector>
#include <d3dcompiler.h>
#include "SR.hpp"
using Microsoft::WRL::ComPtr;
static HWND host=nullptr, window=nullptr;
static HANDLE sourceProcess=nullptr;
static std::atomic<bool> running{true}, active{true};
static std::mutex pendingMutex, outputMutex;
struct Frame{unsigned long long id=0; HANDLE handle=nullptr;};
static Frame pending;
static ComPtr<ID3D11Device> device;
static ComPtr<ID3D11DeviceContext> context;
static ComPtr<IDXGISwapChain> swapchain;
// Flip-model presentation (DXGI_SWAP_EFFECT_FLIP_DISCARD on a no-redirection-bitmap window) avoids the
// legacy blt + layered-window redirection copy, and the frame-latency waitable keeps the queue at one frame
// so the weave always uses the freshest eye position. The legacy blt path is kept as a fallback.
static bool flipModel=false;
static HANDLE frameWaitable=nullptr;
static UINT swapFlags=0;
static POINT windowOrigin{};
static ComPtr<ID3D11RenderTargetView> output;
static ComPtr<ID3D11Texture2D> input;
static ComPtr<ID3D11ShaderResourceView> inputView;
static SimulatedReality::SRInterfaceDX11* sr=nullptr;
static int width=0,height=0;
struct Upload{unsigned long long id;ComPtr<ID3D11Texture2D> source;ComPtr<IDXGIKeyedMutex> mutex;ComPtr<ID3D11Query> query;bool locked;};
static std::deque<Upload> uploads;
static bool ready=false, visible=false;
static void emit(const std::string& s);
static bool cursorPipeline=false;
static bool createCursorPipeline();
static void pollUploads(){while(!uploads.empty()){auto& u=uploads.front();if(context->GetData(u.query.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH)==S_FALSE)break;if(u.locked)u.mutex->ReleaseSync(0);emit("{\"type\":\"release\",\"id\":"+std::to_string(u.id)+"}");uploads.pop_front();}}
static void emit(const std::string& s){std::lock_guard<std::mutex> l(outputMutex);std::cout<<s<<std::endl;}
static void error(const char* message){emit(std::string("{\"type\":\"error\",\"message\":\"")+message+"\"}");running=false;}
static bool createSR(){
 __try { return SUCCEEDED(SimulatedReality::CreateSRInterfaceDX11(context.Get(),window,&sr))&&sr; }
 __except(EXCEPTION_EXECUTE_HANDLER){return false;}
}
static bool weave(){__try{sr->Weave();return true;}__except(EXCEPTION_EXECUTE_HANDLER){return false;}}
static void lens(bool enabled){if(!sr)return;__try{if(enabled)SimulatedReality::SREnableLensHint();else SimulatedReality::SRDisableLensHint();}__except(EXCEPTION_EXECUTE_HANDLER){}}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l){if(m==WM_NCHITTEST)return HTTRANSPARENT;if(m==WM_MOUSEACTIVATE)return MA_NOACTIVATE;if(m==WM_CLOSE){running=false;return 0;}return DefWindowProc(h,m,w,l);}
// Input-transparent, non-activating overlay owned by the launcher window. With flip model the window has no
// redirection bitmap, so DWM scans the swap chain out directly instead of copying through a GDI surface.
static HWND createOverlay(bool flip){
 const DWORD ex=WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW|(flip?WS_EX_NOREDIRECTIONBITMAP:0);
 HWND w=CreateWindowExW(ex,L"PyroCadeLeiaPresenter",L"PyroCade Leia SR",WS_POPUP,windowOrigin.x,windowOrigin.y,width,height,host,nullptr,GetModuleHandle(nullptr),nullptr);
 if(w)SetLayeredWindowAttributes(w,0,255,LWA_ALPHA);
 return w;
}
static bool setup(HANDLE shared){
 ComPtr<IDXGIFactory2> factory; if(FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))return false;
 ComPtr<IDXGIAdapter> adapter;
 if(shared){LUID luid{};if(SUCCEEDED(factory->GetSharedResourceAdapterLuid(shared,&luid))){for(UINT i=0;;i++){ComPtr<IDXGIAdapter> a;if(FAILED(factory->EnumAdapters(i,&a)))break;DXGI_ADAPTER_DESC d{};a->GetDesc(&d);if(d.AdapterLuid.HighPart==luid.HighPart&&d.AdapterLuid.LowPart==luid.LowPart){adapter=a;break;}}}}
 D3D_FEATURE_LEVEL level; if(FAILED(D3D11CreateDevice(adapter.Get(),adapter?D3D_DRIVER_TYPE_UNKNOWN:D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,&level,&context)))return false;
 ComPtr<IDXGIDevice> gpuDevice;device.As(&gpuDevice);ComPtr<IDXGIAdapter> selected;gpuDevice->GetAdapter(&selected);DXGI_ADAPTER_DESC gpu{};selected->GetDesc(&gpu);char gpuName[256]{};WideCharToMultiByte(CP_UTF8,0,gpu.Description,-1,gpuName,255,nullptr,nullptr);emit(std::string("{\"type\":\"gpu\",\"name\":\"")+gpuName+"\"}");
 if(flipModel){
  DXGI_SWAP_CHAIN_DESC1 desc{};desc.Width=width;desc.Height=height;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=2;desc.Scaling=DXGI_SCALING_NONE;desc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_DISCARD;desc.AlphaMode=DXGI_ALPHA_MODE_IGNORE;desc.Flags=DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
  ComPtr<IDXGISwapChain1> flip;
  if(SUCCEEDED(factory->CreateSwapChainForHwnd(device.Get(),window,&desc,nullptr,nullptr,&flip))){
   swapFlags=desc.Flags;flip.As(&swapchain);ComPtr<IDXGISwapChain2> waitable;
   if(SUCCEEDED(flip.As(&waitable))){waitable->SetMaximumFrameLatency(1);frameWaitable=waitable->GetFrameLatencyWaitableObject();}
  }else{
   // Flip model unavailable: rebuild the overlay as a classic layered window for the blt path.
   flipModel=false;HWND old=window;window=createOverlay(false);DestroyWindow(old);
  }
 }
 if(!flipModel){
  DXGI_SWAP_CHAIN_DESC desc{};desc.BufferCount=2;desc.BufferDesc.Width=width;desc.BufferDesc.Height=height;desc.BufferDesc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.OutputWindow=window;desc.SampleDesc.Count=1;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
  if(FAILED(factory->CreateSwapChain(device.Get(),&desc,&swapchain)))return false;swapFlags=0;
 }
 factory->MakeWindowAssociation(window,DXGI_MWA_NO_ALT_ENTER);
 emit(std::string("{\"type\":\"present\",\"mode\":\"")+(flipModel?"flip":"blt")+"\"}");
 if(!createSR())return false;
 sr->SetShaderSRGBConversion(true,true);sr->SetCrosstalk(SimulatedReality::SRCrosstalkMode::Dynamic,1.0f);
 // A windowed overlay is composed by DWM, so the weave reaches the panel about two refreshes after it is
 // recorded (one with the legacy path's extra redirection copy counted as well). Predict eyes that far ahead.
 sr->SetLatencyInFrames(flipModel?2:3);sr->EnableLateLatching(true);
 cursorPipeline=createCursorPipeline();
 emit(std::string("{\"type\":\"cursor\",\"native\":")+(cursorPipeline?"true":"false")+"}");
 return true;
}
static bool target(int w,int h){
 if(output&&w==width&&h==height)return true;
 context->OMSetRenderTargets(0,nullptr,nullptr);output.Reset();
 if(w!=width||h!=height){if(FAILED(swapchain->ResizeBuffers(0,w,h,DXGI_FORMAT_UNKNOWN,swapFlags)))return false;width=w;height=h;}
 ComPtr<ID3D11Texture2D> back;if(FAILED(swapchain->GetBuffer(0,IID_PPV_ARGS(&back))))return false;
 return SUCCEEDED(device->CreateRenderTargetView(back.Get(),nullptr,&output));
}
// ---------------------------------------------------------------------------------------------------------
// Native stereo cursor. Drawn here, per eye, into the side-by-side texture right before the weave, from the
// real mouse position read every refresh. Mouse movement therefore costs no Chromium rendering at all (the
// old DOM cursor made every move re-render and re-composite both full-resolution eye views). The launcher
// only reports the depth of the object under the pointer, as a per-eye shift in viewport widths.
// ---------------------------------------------------------------------------------------------------------
static ComPtr<ID3D11Texture2D> composed;
static ComPtr<ID3D11ShaderResourceView> composedView;
static ComPtr<ID3D11RenderTargetView> composedTarget;
static ComPtr<ID3D11ShaderResourceView> spriteView;
static ComPtr<ID3D11VertexShader> cursorVS;
static ComPtr<ID3D11PixelShader> cursorPS;
static ComPtr<ID3D11Buffer> cursorConstants;
static ComPtr<ID3D11BlendState> cursorBlend;
static ComPtr<ID3D11SamplerState> cursorSampler;
static ComPtr<ID3D11RasterizerState> cursorRaster;
static std::atomic<float> cursorShift{0.f};
static std::atomic<bool> cursorEnabled{true};
static bool sceneDirty=true;
static const int spriteScale=4;
static const float spriteW=34.f, spriteH=44.f, hotX=4.f, hotY=3.f; // logical pixels (100% scale)
static bool insidePolygon(const float* xs,const float* ys,int n,float x,float y){bool in=false;for(int i=0,j=n-1;i<n;j=i++)if(((ys[i]>y)!=(ys[j]>y))&&(x<(xs[j]-xs[i])*(y-ys[i])/(ys[j]-ys[i])+xs[i]))in=!in;return in;}
// The themed PyroCade arrow (same outline as the old CSS cursor), rasterised with 4x4 supersampling into a
// premultiplied-alpha sprite at 4x resolution so it stays crisp at any display scale.
static bool createSprite(){
 static const float px[7]={0.f,0.f,.28f,.47f,.64f,.45f,.82f}, py[7]={0.f,.9f,.68f,1.f,.91f,.59f,.57f};
 struct Layer{float x,y,w,h;float r,g,b;bool gradient;};
 const Layer layers[]={{hotX-3,hotY+5,25,34,.32f,.15f,.06f,false},{hotX-2,hotY+3,25,34,.32f,.15f,.06f,false},{hotX-1,hotY+2,25,34,.61f,.29f,.12f,false},{hotX,hotY,25,34,1.f,.72f,.46f,false},{hotX+2,hotY+2,20,28,1.f,1.f,1.f,true}};
 const int tw=int(spriteW)*spriteScale, th=int(spriteH)*spriteScale;std::vector<unsigned char> pixels(size_t(tw)*th*4,0);
 for(int ty=0;ty<th;ty++)for(int tx=0;tx<tw;tx++){
  float r=0,g=0,b=0,a=0;
  for(const auto& L:layers){
   float xs[7],ys[7];for(int k=0;k<7;k++){xs[k]=L.x+px[k]*L.w;ys[k]=L.y+py[k]*L.h;}
   int hits=0;for(int sy=0;sy<4;sy++)for(int sx=0;sx<4;sx++)if(insidePolygon(xs,ys,7,(tx+(sx+.5f)/4)/spriteScale,(ty+(sy+.5f)/4)/spriteScale))hits++;
   if(!hits)continue;const float c=hits/16.f;float lr=L.r,lg=L.g,lb=L.b;
   if(L.gradient){ // 145deg: white -> #fff0e3 at 65% -> #ffc28f
    const float u=std::clamp(((tx/float(spriteScale)-L.x)*.574f+(ty/float(spriteScale)-L.y)*.819f)/(L.w*.574f+L.h*.819f),0.f,1.f);
    const float k=u<.65f?u/.65f:(u-.65f)/.35f;lr=1.f;
    if(u<.65f){lg=1.f+(.941f-1.f)*k;lb=1.f+(.890f-1.f)*k;}else{lg=.941f+(.761f-.941f)*k;lb=.890f+(.561f-.890f)*k;}
   }
   r=lr*c+r*(1-c);g=lg*c+g*(1-c);b=lb*c+b*(1-c);a=c+a*(1-c);
  }
  unsigned char* o=&pixels[(size_t(ty)*tw+tx)*4];o[0]=(unsigned char)(r*255+.5f);o[1]=(unsigned char)(g*255+.5f);o[2]=(unsigned char)(b*255+.5f);o[3]=(unsigned char)(a*255+.5f);
 }
 D3D11_TEXTURE2D_DESC d{};d.Width=tw;d.Height=th;d.MipLevels=1;d.ArraySize=1;d.Format=DXGI_FORMAT_R8G8B8A8_UNORM;d.SampleDesc.Count=1;d.Usage=D3D11_USAGE_IMMUTABLE;d.BindFlags=D3D11_BIND_SHADER_RESOURCE;
 D3D11_SUBRESOURCE_DATA init{pixels.data(),UINT(tw*4),0};ComPtr<ID3D11Texture2D> texture;
 return SUCCEEDED(device->CreateTexture2D(&d,&init,&texture))&&SUCCEEDED(device->CreateShaderResourceView(texture.Get(),nullptr,&spriteView));
}
static bool createCursorPipeline(){
 static const char source[]=
  "cbuffer C:register(b0){float4 rect;float4 tint;};"
  "struct V{float4 p:SV_Position;float2 uv:TEXCOORD0;};"
  "V vs(uint id:SV_VertexID){float2 c=float2(id&1,id>>1);V o;o.uv=c;o.p=float4(lerp(rect.x,rect.z,c.x),lerp(rect.y,rect.w,c.y),0,1);return o;}"
  "Texture2D sprite:register(t0);SamplerState linearSampler:register(s0);"
  "float4 ps(V i):SV_Target{return sprite.Sample(linearSampler,i.uv)*tint.a;}";
 ComPtr<ID3DBlob> vsCode,psCode,errors;
 if(FAILED(D3DCompile(source,sizeof source-1,"cursor",nullptr,nullptr,"vs","vs_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&vsCode,&errors)))return false;
 if(FAILED(D3DCompile(source,sizeof source-1,"cursor",nullptr,nullptr,"ps","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&psCode,&errors)))return false;
 if(FAILED(device->CreateVertexShader(vsCode->GetBufferPointer(),vsCode->GetBufferSize(),nullptr,&cursorVS))||FAILED(device->CreatePixelShader(psCode->GetBufferPointer(),psCode->GetBufferSize(),nullptr,&cursorPS)))return false;
 D3D11_BUFFER_DESC b{};b.ByteWidth=32;b.Usage=D3D11_USAGE_DEFAULT;b.BindFlags=D3D11_BIND_CONSTANT_BUFFER;if(FAILED(device->CreateBuffer(&b,nullptr,&cursorConstants)))return false;
 D3D11_BLEND_DESC blend{};blend.RenderTarget[0].BlendEnable=TRUE;blend.RenderTarget[0].SrcBlend=D3D11_BLEND_ONE;blend.RenderTarget[0].DestBlend=D3D11_BLEND_INV_SRC_ALPHA;blend.RenderTarget[0].BlendOp=D3D11_BLEND_OP_ADD;blend.RenderTarget[0].SrcBlendAlpha=D3D11_BLEND_ONE;blend.RenderTarget[0].DestBlendAlpha=D3D11_BLEND_INV_SRC_ALPHA;blend.RenderTarget[0].BlendOpAlpha=D3D11_BLEND_OP_ADD;blend.RenderTarget[0].RenderTargetWriteMask=D3D11_COLOR_WRITE_ENABLE_ALL;
 if(FAILED(device->CreateBlendState(&blend,&cursorBlend)))return false;
 D3D11_SAMPLER_DESC s{};s.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;s.AddressU=s.AddressV=s.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;s.MaxLOD=D3D11_FLOAT32_MAX;if(FAILED(device->CreateSamplerState(&s,&cursorSampler)))return false;
 D3D11_RASTERIZER_DESC rs{};rs.FillMode=D3D11_FILL_SOLID;rs.CullMode=D3D11_CULL_NONE;rs.ScissorEnable=TRUE;rs.DepthClipEnable=TRUE;if(FAILED(device->CreateRasterizerState(&rs,&cursorRaster)))return false;
 return createSprite();
}
// The weaver samples `composed` = the latest eye frame plus the cursor. Recreated when the frame size changes.
static bool createComposed(const D3D11_TEXTURE2D_DESC& source){
 composedTarget.Reset();composedView.Reset();composed.Reset();
 D3D11_TEXTURE2D_DESC d=source;d.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_RENDER_TARGET;d.MiscFlags=0;d.Usage=D3D11_USAGE_DEFAULT;d.CPUAccessFlags=0;d.MipLevels=1;d.ArraySize=1;
 if(FAILED(device->CreateTexture2D(&d,nullptr,&composed))||FAILED(device->CreateShaderResourceView(composed.Get(),nullptr,&composedView))||FAILED(device->CreateRenderTargetView(composed.Get(),nullptr,&composedTarget)))return false;
 sr->SetInputTexture(composedView.Get());sceneDirty=true;return true;
}
struct CursorState{int x=-100000,y=-100000;float alpha=0,shift=0;bool operator!=(const CursorState& o)const{return x!=o.x||y!=o.y||std::fabs(alpha-o.alpha)>.002f||std::fabs(shift-o.shift)>1e-6f;}};
static CursorState drawnCursor;
// Per refresh: read the real pointer, fade after 5 s without movement or clicks, recompose only on change.
static void composeFrame(POINT origin,const RECT& client,ULONGLONG now){
 static POINT lastPointer{-1,-1};static ULONGLONG lastActivity=0,lastTick=0;static float alpha=0;
 POINT c{};GetCursorPos(&c);
 const bool buttons=(GetAsyncKeyState(VK_LBUTTON)|GetAsyncKeyState(VK_RBUTTON)|GetAsyncKeyState(VK_MBUTTON))&0x8000;
 if(c.x!=lastPointer.x||c.y!=lastPointer.y||buttons){lastPointer=c;lastActivity=now;}
 const int cx=c.x-origin.x, cy=c.y-origin.y;
 const bool inside=cx>=0&&cy>=0&&cx<client.right&&cy<client.bottom;
 const bool wanted=cursorPipeline&&cursorEnabled&&inside&&now-lastActivity<5000;
 const float dt=lastTick?float(now-lastTick):0.f;lastTick=now;
 alpha=wanted?1.f:(std::max)(0.f,alpha-dt/350.f);
 CursorState next;next.alpha=alpha;if(alpha>0){next.x=cx;next.y=cy;next.shift=cursorShift.load();}
 static ULONGLONG lastReport=0; // diagnostics, twice a second
 if(now-lastReport>=500){lastReport=now;emit("{\"type\":\"cursorState\",\"x\":"+std::to_string(cx)+",\"y\":"+std::to_string(cy)+",\"inside\":"+(inside?"true":"false")+",\"alpha\":"+std::to_string(next.alpha)+",\"shift\":"+std::to_string(next.shift)+",\"idleMs\":"+std::to_string(now-lastActivity)+"}");}
 if(!sceneDirty&&!(next!=drawnCursor))return;
 context->CopyResource(composed.Get(),input.Get());
 if(next.alpha>0){
  D3D11_TEXTURE2D_DESC d{};composed->GetDesc(&d);const float tw=float(d.Width),th=float(d.Height),eye=tw/2;
  const float sx=eye/float(client.right),sy=th/float(client.bottom),scale=GetDpiForWindow(host)/96.f;
  const float shiftPx=next.shift*float(client.right);
  ID3D11RenderTargetView* rt=composedTarget.Get();context->OMSetRenderTargets(1,&rt,nullptr);
  D3D11_VIEWPORT vp{0,0,tw,th,0,1};context->RSSetViewports(1,&vp);context->RSSetState(cursorRaster.Get());
  const float blendFactor[4]={0,0,0,0};context->OMSetBlendState(cursorBlend.Get(),blendFactor,0xffffffff);
  context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
  context->VSSetShader(cursorVS.Get(),nullptr,0);context->PSSetShader(cursorPS.Get(),nullptr,0);
  ID3D11Buffer* cb=cursorConstants.Get();context->VSSetConstantBuffers(0,1,&cb);context->PSSetConstantBuffers(0,1,&cb);
  ID3D11ShaderResourceView* srv=spriteView.Get();context->PSSetShaderResources(0,1,&srv);ID3D11SamplerState* smp=cursorSampler.Get();context->PSSetSamplers(0,1,&smp);
  for(int e=0;e<2;e++){
   const float x=(e?eye:0.f)+(float(next.x)+(e?-shiftPx:shiftPx)-hotX*scale)*sx, y=(float(next.y)-hotY*scale)*sy;
   const float w=spriteW*scale*sx, h=spriteH*scale*sy;
   const float data[8]={x/tw*2-1,1-y/th*2,(x+w)/tw*2-1,1-(y+h)/th*2,1,1,1,next.alpha};
   context->UpdateSubresource(cursorConstants.Get(),0,nullptr,data,0,0);
   D3D11_RECT scissor{LONG(e?eye:0),0,LONG(e?tw:eye),LONG(th)};context->RSSetScissorRects(1,&scissor);
   context->Draw(4,0);
  }
  ID3D11ShaderResourceView* none=nullptr;context->PSSetShaderResources(0,1,&none);
  context->OMSetBlendState(nullptr,blendFactor,0xffffffff);context->RSSetState(nullptr);context->OMSetRenderTargets(0,nullptr,nullptr);
 }
 {static bool dumped=false;char path[260]{};if(!dumped&&next.alpha>=1.f&&GetEnvironmentVariableA("PYROCADE_LEIA_DUMP",path,sizeof path)){dumped=true;
  D3D11_TEXTURE2D_DESC d{};composed->GetDesc(&d);d.BindFlags=0;d.Usage=D3D11_USAGE_STAGING;d.CPUAccessFlags=D3D11_CPU_ACCESS_READ;d.MiscFlags=0;ComPtr<ID3D11Texture2D> staging;
  if(SUCCEEDED(device->CreateTexture2D(&d,nullptr,&staging))){context->CopyResource(staging.Get(),composed.Get());D3D11_MAPPED_SUBRESOURCE m{};if(SUCCEEDED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&m))){FILE* f=nullptr;fopen_s(&f,path,"wb");if(f){fprintf(f,"P6 %u %u 255\n",d.Width,d.Height);for(UINT y=0;y<d.Height;y++){const unsigned char* row=(const unsigned char*)m.pData+size_t(y)*m.RowPitch;for(UINT x=0;x<d.Width;x++){unsigned char px[3]={row[x*4+2],row[x*4+1],row[x*4]};fwrite(px,1,3,f);}}fclose(f);}context->Unmap(staging.Get(),0);}}
  emit("{\"type\":\"dump\",\"format\":"+std::to_string(d.Format)+",\"x\":"+std::to_string(next.x)+",\"y\":"+std::to_string(next.y)+"}");}}
 drawnCursor=next;sceneDirty=false;
}
static bool receive(Frame f){
 ComPtr<ID3D11Device1> d1;device.As(&d1);ComPtr<ID3D11Texture2D> shared;
 if(!d1||FAILED(d1->OpenSharedResource1(f.handle,IID_PPV_ARGS(&shared))))return false;
 D3D11_TEXTURE2D_DESC desc{};shared->GetDesc(&desc);const bool crop=desc.Width%2!=0;desc.Width&=~1u;D3D11_TEXTURE2D_DESC old{};if(input)input->GetDesc(&old);
 if(!input||old.Width!=desc.Width||old.Height!=desc.Height||old.Format!=desc.Format){inputView.Reset();input.Reset();desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;desc.MiscFlags=0;desc.Usage=D3D11_USAGE_DEFAULT;desc.CPUAccessFlags=0;
 if(FAILED(device->CreateTexture2D(&desc,nullptr,&input))||FAILED(device->CreateShaderResourceView(input.Get(),nullptr,&inputView))||!createComposed(desc))return false;}
 ComPtr<IDXGIKeyedMutex> mutex;shared.As(&mutex);bool locked=false;if(mutex){if(mutex->AcquireSync(0,100)!=S_OK)return false;locked=true;}
 if(crop){D3D11_BOX box{0,0,0,desc.Width,desc.Height,1};context->CopySubresourceRegion(input.Get(),0,0,0,0,shared.Get(),0,&box);}else context->CopyResource(input.Get(),shared.Get());
 D3D11_QUERY_DESC queryDesc{D3D11_QUERY_EVENT,0};ComPtr<ID3D11Query> query;if(FAILED(device->CreateQuery(&queryDesc,&query))){if(locked)mutex->ReleaseSync(0);return false;}
 context->End(query.Get());context->Flush();uploads.push_back({f.id,shared,mutex,query,locked});sceneDirty=true;return true;
}
int main(int argc,char**argv){
 SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
 bool probe=argc>1&&std::string(argv[1])=="--probe";
 if(!probe&&argc>=3){host=reinterpret_cast<HWND>(std::stoull(argv[1]));sourceProcess=OpenProcess(PROCESS_DUP_HANDLE,FALSE,DWORD(std::stoul(argv[2])));}
 SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS|LOAD_LIBRARY_SEARCH_USER_DIRS);
 AddDllDirectory(L"C:\\Program Files\\LeiaSR\\Platform\\bin");AddDllDirectory(L"C:\\Program Files\\Simulated Reality\\SR Platform\\bin");
 if(!LoadLibraryW(L"SimulatedRealityCore.dll")||!LoadLibraryW(L"SimulatedRealityDirectX.dll")){error("Leia SR runtime could not be loaded.");return 2;}
 WNDCLASSW wc{};wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandle(nullptr);wc.lpszClassName=L"PyroCadeLeiaPresenter";RegisterClassW(&wc);
 RECT rect{0,0,1280,720};POINT point{};if(host){GetClientRect(host,&rect);ClientToScreen(host,&point);}width=rect.right;height=rect.bottom;windowOrigin=point;
 char legacy[8]{};flipModel=!GetEnvironmentVariableA("PYROCADE_LEIA_BLT",legacy,sizeof legacy);
 window=createOverlay(flipModel);
 if(probe){bool ok=setup(nullptr);emit(ok?"{\"type\":\"ready\"}":"{\"type\":\"error\",\"message\":\"SR display or service unavailable.\"}");if(sr){lens(false);sr->Delete();sr=nullptr;}DestroyWindow(window);return ok?0:3;}
 if(!host||!sourceProcess){error("Could not connect to the launcher window.");return 4;}
 std::thread([]{std::string line;while(running&&std::getline(std::cin,line)){std::istringstream in(line);std::string cmd;in>>cmd;if(cmd=="QUIT"){running=false;break;}if(cmd=="ACTIVE"){int flag;in>>flag;active=flag!=0;}if(cmd=="CURSOR"){float shift=0;if(in>>shift&&std::isfinite(shift))cursorShift=std::clamp(shift,-.25f,.25f);}if(cmd=="CURSORMODE"){int flag=1;in>>flag;cursorEnabled=flag!=0;}if(cmd=="FRAME"){Frame f;unsigned long long raw=0;in>>f.id>>raw;if(!DuplicateHandle(sourceProcess,reinterpret_cast<HANDLE>(raw),GetCurrentProcess(),&f.handle,0,FALSE,DUPLICATE_SAME_ACCESS)){error("Could not open the shared stereo frame.");break;}std::lock_guard<std::mutex> lock(pendingMutex);if(pending.handle){CloseHandle(pending.handle);emit("{\"type\":\"release\",\"id\":"+std::to_string(pending.id)+",\"copied\":false}");}pending=f;}}running=false;}).detach();
 emit("{\"type\":\"prepared\"}");
 unsigned long long sourceFrame=0, lastPresentedFrame=0;
 unsigned int freshFrames=0, presentedFrames=0;
 ULONGLONG sampleStart=GetTickCount64(), lastFreshTime=0, longestGap=0;
 while(running&&IsWindow(host)){
  // Pace on the swap chain: wake when a buffer frees up, then take the newest eye frame and weave
  // with the freshest tracking, so nothing waits behind a stale frame.
  if(visible&&frameWaitable)WaitForSingleObjectEx(frameWaitable,50,TRUE);
  MSG message;while(PeekMessage(&message,nullptr,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessage(&message);}
  POINT p{};RECT r{};GetClientRect(host,&r);ClientToScreen(host,&p);if(context)pollUploads();
  Frame f;{std::lock_guard<std::mutex> lock(pendingMutex);f=pending;pending={};}
  if(f.handle){if(!device&&!setup(f.handle)){CloseHandle(f.handle);error("Leia SR display initialization failed.");break;}bool ok=receive(f);CloseHandle(f.handle);if(!ok){error("The GPU could not read the stereo frame.");break;}sourceFrame=f.id;if(!ready){ready=true;emit("{\"type\":\"ready\"}");}}
  const bool show=active&&input&&GetForegroundWindow()==host&&IsWindowVisible(host)&&!IsIconic(host)&&IsWindowEnabled(host)&&r.right>0&&r.bottom>0;
  if(!show){if(visible){ShowWindow(window,SW_HIDE);lens(false);visible=false;}sampleStart=GetTickCount64();lastFreshTime=longestGap=freshFrames=presentedFrames=0;Sleep(uploads.empty()?4:1);continue;}
  RECT current{};GetWindowRect(window,&current);if(current.left!=p.x||current.top!=p.y||current.right-current.left!=r.right||current.bottom-current.top!=r.bottom)SetWindowPos(window,HWND_TOP,p.x,p.y,r.right,r.bottom,SWP_NOACTIVATE|SWP_NOOWNERZORDER);
  if(!target(r.right,r.bottom)){error("Could not resize the stereo output.");break;}
  if(composed)composeFrame(p,r,GetTickCount64());
  ID3D11RenderTargetView* view=output.Get();context->OMSetRenderTargets(1,&view,nullptr);D3D11_VIEWPORT vp{0,0,float(width),float(height),0,1};context->RSSetViewports(1,&vp);
  float black[4]={0,0,0,1};context->ClearRenderTargetView(output.Get(),black);
  if(!weave()){error("The SR weaver stopped responding.");break;}
  if(!visible){ShowWindow(window,SW_SHOWNOACTIVATE);lens(true);visible=true;}
  const HRESULT presented=swapchain->Present(1,0);
  if(FAILED(presented)){error("The 3D display connection was lost.");break;}
  const ULONGLONG now=GetTickCount64();++presentedFrames;
  if(presented==S_OK&&sourceFrame!=lastPresentedFrame){
   lastPresentedFrame=sourceFrame;
   if(lastFreshTime)longestGap=(std::max)(longestGap,now-lastFreshTime);
   lastFreshTime=now;
   ++freshFrames;
  }
  if(now-sampleStart>=1000){
   emit("{\"type\":\"cadence\",\"fps\":"+std::to_string(freshFrames*1000.0/(now-sampleStart))+",\"presentFps\":"+std::to_string(presentedFrames*1000.0/(now-sampleStart))+",\"longestGapMs\":"+std::to_string(longestGap)+",\"mode\":\""+(flipModel?"flip":"blt")+"\"}");
   sampleStart=now;
   freshFrames=presentedFrames=0;
   longestGap=0;
  }
  if(!ready){ready=true;emit("{\"type\":\"ready\"}");}
 }
 lens(false);if(sr){sr->Delete();sr=nullptr;}if(frameWaitable)CloseHandle(frameWaitable);if(window)DestroyWindow(window);if(sourceProcess)CloseHandle(sourceProcess);return 0;
}
