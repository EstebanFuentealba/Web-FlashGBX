# SPDX-License-Identifier: GPL-3.0-or-later
"""Browser adapter for the unmodified FlashGBX cartridge engine.
All serial I/O is delegated to the browser-owned USB permission/session.
"""
import sys, types, json, os, glob, re, time, copy, io, zipfile, traceback
import browser_io

class SerialException(IOError): pass
class SerialTimeoutException(SerialException): pass

class BrowserSerial:
    def __init__(self, port='browser', baudrate=2000000, timeout=1, **kwargs):
        self.port, self.baudrate, self.timeout, self.is_open = port, baudrate, timeout, True
    def isOpen(self): return self.is_open
    def open(self): self.is_open = True
    def close(self): self.is_open = False
    def flush(self): pass
    def reset_input_buffer(self): browser_io.reset()
    def reset_output_buffer(self): pass
    def read(self, size=1):
        if not self.is_open: raise SerialException('Serial session closed')
        result = bytearray()
        deadline = time.monotonic() + (self.timeout if self.timeout is not None else 3600)
        while len(result) < size:
            count = min(size-len(result), 65536)
            chunk = bytes(browser_io.read(count, max(0, int((deadline-time.monotonic())*1000))).to_py())
            result.extend(chunk)
            if len(chunk) < count: break
        return bytes(result)
    def write(self, data):
        if not self.is_open: raise SerialException('Serial session closed')
        for offset in range(0,len(data),65536): browser_io.write(list(data[offset:offset+65536]))
        return len(data)
    @property
    def in_waiting(self): return browser_io.waiting()
    @property
    def out_waiting(self): return 0

serial = types.ModuleType('serial'); serial.__path__=[]
serial.Serial=BrowserSerial; serial.SerialException=SerialException; serial.SerialTimeoutException=SerialTimeoutException
serial.__version__='browser'; serial.VERSION='browser'
serial.serialutil=types.ModuleType('serial.serialutil')
serial.serialutil.PortNotOpenError=SerialException
serial.serialutil.SerialException=SerialException; serial.serialutil.SerialTimeoutException=SerialTimeoutException
serial.tools=types.ModuleType('serial.tools'); serial.tools.__path__=[]
serial.tools.list_ports=types.ModuleType('serial.tools.list_ports'); serial.tools.list_ports.comports=lambda:[]
for name, module in [('serial',serial),('serial.serialutil',serial.serialutil),('serial.tools',serial.tools),('serial.tools.list_ports',serial.tools.list_ports)]: sys.modules[name]=module
sys.path.insert(0,'/app')
from FlashGBX.app import AppContext, AppInfo
from FlashGBX.hw_GBFlash import GbxDevice as GBFlash
from FlashGBX.hw_GBxCartRW import GbxDevice as GBxCart
from FlashGBX.Flashcart import empty_flashcarts_map
from FlashGBX.CartridgeTypes import RomSizes, AgbSaveTypes, DmgSaveTypes
from FlashGBX.Mapper import DMG_Mapper
from FlashGBX.PocketCamera import PocketCamera
from FlashGBX.RomFileDMG import from_isx
AppContext.APP_PATH='/app/FlashGBX'; AppContext.CONFIG_PATH='/app/FlashGBX/config'
os.makedirs('/data',exist_ok=True)
profiles=empty_flashcarts_map()
for path in sorted(glob.glob(AppContext.CONFIG_PATH+'/fc_*.txt')):
    with open(path,encoding='utf-8') as stream:
        config=json.loads(re.sub(r'0x[0-9A-Fa-f]+',lambda m:str(int(m[0],16)),stream.read()))
    for name in config.get('names',[]):
        if config.get('type') in profiles:
            profile=copy.deepcopy(config); profile['names']=[name]; profiles[config['type']][name]=profile

device=None
header=None
selected_profile=0
last_progress=0
transfer_size=0
transfer_pos=0
operation_error=None

def clean(value):
    if value is None or isinstance(value,(str,int,float,bool)): return value
    if isinstance(value,(bytes,bytearray,memoryview)): return list(value) if len(value)<2048 else {'bytes':len(value)}
    if isinstance(value,dict): return {str(k):clean(v) for k,v in value.items() if k not in ('logo','logo_sachen','data')}
    if isinstance(value,(list,tuple)): return [clean(v) for v in value]
    return str(value)

def progress(event):
    global last_progress,transfer_size,transfer_pos,operation_error
    if event.get('action') in ('ABORT','ERROR') or (event.get('action')=='FINISHED' and event.get('verified') is False):
        operation_error=event.get('info_msg') or event.get('text') or 'La verificación de lectura posterior falló.'
    if browser_io.cancelled() and device:
        device.CANCEL=True; device.CANCEL_ARGS={'from_user':True}
    if event.get('action')=='USER_ACTION':
        device.USER_ANSWER=bool(browser_io.ask(json.dumps(clean(event))))
        return
    if event.get('action')=='INITIALIZE': transfer_size=event.get('size',0); transfer_pos=event.get('pos',0)
    if event.get('action') in ('READ','WRITE'): transfer_pos+=event.get('bytes_added',0)
    if 'pos' in event: transfer_pos=event['pos']
    now=time.monotonic()
    if now-last_progress>0.05 or event.get('action') not in ('READ','WRITE','UPDATE_POS'):
        data=clean(event); data['position']=transfer_pos; data['total']=transfer_size
        browser_io.emit(json.dumps(data)); last_progress=now

# Browser user prompts are synchronous inside the worker, so the upstream
# polling loop is replaced by a synchronous reconnect + restore sequence.
def reconnect_cart():
    if device.CanPowerCycleCart(): return device.CartPowerCycle()
    mode=device.MODE; state=device.GetVarState()
    if not browser_io.ask(json.dumps({'action':'USER_ACTION','user_action':'RECONNECT_USB','title':'Reconectar USB','msg':'Desconecta y reconecta físicamente el USB para cortar la alimentación; luego pulsa Reconectar USB.'})):
        device.CANCEL=True; device.CANCEL_ARGS={'from_user':True}; return False
    device.DEVICE=BrowserSerial(timeout=device.DEVICE_TIMEOUT)
    device.LoadFirmwareVersion(); device.SetMode(mode); device.SetVarState(state)
    return True

def connect(args):
    global device,header,selected_profile
    device=(GBFlash if args.get('name','GBFlash')=='GBFlash' else GBxCart)()
    device.INFO={'action':None,'last_action':None,'dump_info':{}}
    device.FW={}; device.FW_VAR={}; device.CANCEL_ARGS={}; device.ERROR_ARGS={}
    device.DEVICE=BrowserSerial(baudrate=args.get('baud',2000000),timeout=1)
    device.PORT='browser'; device.BAUDRATE=args.get('baud',2000000)
    if not device.LoadFirmwareVersion() or device.FW.get('cfw_id')!='L' or device.FW.get('fw_ver')!=15: raise RuntimeError('Se requiere firmware LK L15.')
    device.MAX_BUFFER_READ=0x1000; device.MAX_BUFFER_WRITE=0x800 if device.FW['pcb_name']=='GBFlash' else 0x400
    device.UpdateFlashCarts(profiles); device.CartPowerCycleOrAskReconnect=reconnect_cart
    device.SetAutoPowerOff(5000); device.SIGNAL=progress; header=None; selected_profile=0
    device.CartPowerOff()
    return {'firmware':clean(device.FW),'profiles':profile_list()}

def profile_list():
    if not device: return {}
    return {mode:[{'index':i,'name':name,'size':value.get('flash_size') if isinstance(value,dict) else None,'voltage':value.get('voltage') if isinstance(value,dict) else None} for i,(name,value) in enumerate(carts.items())] for mode,carts in device.SUPPORTED_CARTS.items()}

def capabilities_json():
    return json.dumps({'version':AppInfo.VERSION_PEP440,'profiles':{k:len(v) for k,v in profiles.items()},'romSizes':{'DMG':RomSizes.ROM_SIZES_DMG,'AGB':RomSizes.ROM_SIZES},'saveTypes':{'DMG':[{'value':v,'size':size,'name':name} for v,size,name in DmgSaveTypes.RAM_TYPES],'AGB':[{'value':i,'size':size,'name':name or 'None'} for i,(size,name) in enumerate(AgbSaveTypes.SAVE_TYPES)]},'cameraPalettes':PocketCamera.PALETTE_NAMES,'actions':['inspect','analyze','backup-rom','write-rom','backup-save','restore-save','erase-save','read-rtc','write-rtc','camera-extract','dump-report','convert-isx','console','firmware-gbflash']})

def cart_info(args=None):
    args=args or {}; h=header or {}; dmg=device.MODE=='DMG'; raw=h.get('raw',b'')
    db=h.get('db') or {}; code=h.get('game_code','')
    if dmg:
        code=db.get('gc') or ('DMG-'+code if code else '')
        rom_size=RomSizes().GetSize(h.get('rom_size_raw',0)) or 32768
        save_type=h.get('ram_size_raw',0); ram_size=DmgSaveTypes(mbc=save_type).GetSize()
        mapper=h.get('mapper','Unknown')
    else:
        code=db.get('gc') or ('AGB-'+code if code else '')
        rom_size=h.get('rom_size') or args.get('romSize') or 33554432
        save_type=h.get('save_type') or 0; ram_size=AgbSaveTypes(save_type).GetSize() or 0; mapper='Lineal'
    return {'mode':device.MODE,'title':h.get('game_title','SIN TITULO'),'gameName':db.get('gn') or h.get('game_title','SIN TITULO'),'productCode':code,'revision':h.get('version',0),'system':'Game Boy Color' if dmg and h.get('cgb') in (0x80,0xc0) else 'Game Boy' if dmg else 'Game Boy Advance','romSize':rom_size,'ramSize':ram_size,'mapper':mapper,'type':h.get('mapper_raw',0),'saveType':save_type,'rtc':h.get('has_rtc',False),'rtcString':h.get('rtc_string',''),'rtcDict':clean(h.get('rtc_dict',{})),'header':list(raw[:0x180]),'unsupported':'','engine':True,'profile':selected_profile,'details':clean(h)}

def inspect(args):
    global header,selected_profile
    mode=args.get('mode')
    if mode not in ('DMG','AGB'): raise ValueError('Plataforma inválida.')
    device.SetMode(mode); selected_profile=0
    header=device.ReadHeader(checkRtc=True)
    if not header or header.get('empty_nocart'): raise RuntimeError('No se pudo leer la cabecera del cartucho.')
    return {'cart':cart_info(args),'profiles':profile_list()}

def analyze(args):
    global header,selected_profile
    device.SIGNAL=progress
    detected=device._DetectCartridge_Worker(limitVoltage=not args.get('force5v',False),checkSaveType=args.get('checkSaveType',True),signal=progress)
    if not detected: raise RuntimeError('El análisis no devolvió resultados.')
    header=detected[0]; header['save_type']=detected[2]
    selected_profile=detected[6]
    if device.MODE=='AGB' and detected[1]: header['save_size']=detected[1]
    return {'cart':cart_info(args),'analysis':clean({'saveSize':detected[1],'saveType':detected[2],'saveChip':detected[3],'sramUnstable':detected[4],'profiles':detected[5],'profile':detected[6],'cfiText':detected[7],'cfi':detected[8],'flashId':detected[9],'detectedSize':detected[10]})}

def transfer(args):
    global operation_error
    operation_error=None
    result=device.TransferData(args=args,signal=progress)
    if operation_error or result is False or device.ERROR or device.CANCEL:
        raise RuntimeError(str(operation_error or device.CANCEL_ARGS.get('info_msg') or device.ERROR_ARGS or 'La operación fue cancelada o no pudo verificarse.'))
    return result

def save_type(args):
    value=args.get('saveType')
    if value is not None and str(value)!='auto': return int(value)
    if device.MODE=='DMG': return header.get('ram_size_raw',0)
    if header.get('save_type') is None: analyze(args)
    return header.get('save_type') or 0

def batteryless_region(args):
    region=copy.copy(header.get('batteryless_sram') or device.INFO.get('dump_info',{}).get('batteryless_sram') or {})
    for key in ('bl_offset','bl_size','bl_layout'):
        if key in args: region[key]=int(str(args[key]),0) if isinstance(args[key],str) else int(args[key])
    if not region and device.MODE=='AGB': region=device.CheckBatterylessSRAM() or {}
    if not isinstance(region.get('bl_offset'),int) or not isinstance(region.get('bl_size'),int) or region['bl_offset']<0 or region['bl_size']<=0: raise ValueError('Indica bl_offset y bl_size para la partida batteryless en las opciones avanzadas.')
    if device.MODE=='DMG': region.setdefault('bl_layout',0)
    return region

def batteryless(action,args,path):
    region=batteryless_region(args)
    base={'mbc':args.get('mbc',header.get('mapper_raw',0)),'fast_read_mode':True,**region}
    if action=='backup-save':
        transfer({'mode':1,'path':path,'rom_size':region['bl_size'],'agb_rom_size':region['bl_size'],'cart_type':0,**base})
    else:
        profile=int(args.get('profile',selected_profile))
        if profile<=0: raise ValueError('Selecciona el perfil de flashcart para escribir una partida batteryless.')
        targs={'mode':4,'path':path,'cart_type':profile,'override_voltage':False,'prefer_chip_erase':False,'verify_write':True,'fix_header':False,'fix_bootlogo':False,'compare_sectors':True,'bl_save':True,'flash_offset':region['bl_offset'],'flash_size':region['bl_size'],**base}
        if action=='erase-save': targs.update(path='',buffer=bytearray([255]*region['bl_size']))
        transfer(targs)
    return path

def guard_cartridge():
    expected=header.get('header_sha1')
    current=device.ReadHeader(checkRtc=False)
    if expected and (not current or current.get('header_sha1')!=expected): raise ValueError('El cartucho cambió. Vuelve a identificarlo antes de escribir.')

def backup_save(args,path='/data/backup.sav'):
    kind=save_type(args)
    if not kind: raise ValueError('Elige un tipo de memoria de partida o ejecuta Analyze Flash Cart.')
    if (device.MODE=='DMG' and kind==0x205) or (device.MODE=='AGB' and kind==9): return batteryless('backup-save',args,path)
    transfer({'mode':2,'path':path,'mbc':args.get('mbc',header.get('mapper_raw',0)),'save_type':kind,'rtc':args.get('rtc',True),'cart_type':args.get('profile',selected_profile)})
    return path

def files(*paths): return [{'path':p,'name':os.path.basename(p)} for p in paths if os.path.isfile(p)]

def dispatch(action,args):
    global header,selected_profile
    if action=='connect': return connect(args)
    if action=='camera-extract':
        camera=PocketCamera(); source=args.get('path','/data/input.sav')
        if camera.LoadFile(source) is False: raise ValueError('Partida de Game Boy Camera inválida.')
        palette=args.get('palette','grayscale'); camera.SetPalette(PocketCamera.PALETTE_NAMES.index(palette))
        target='/data/camera'; os.makedirs(target,exist_ok=True)
        for i in range(32): camera.ExportPicture(i,f'{target}/IMG_{i:02d}.png',scale=1)
        out='/data/camera.zip'
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
            for p in glob.glob(target+'/*.png'): archive.write(p,os.path.basename(p))
        return {'files':files(out)}
    if action=='convert-isx':
        path='/data/converted.gb'
        with open(args.get('path','/data/input.isx'),'rb') as stream: data=from_isx(bytearray(stream.read()))
        with open(path,'wb') as stream: stream.write(data)
        return {'files':files(path)}
    if action=='console':
        output=io.StringIO(); namespace={'device':device,'header':header,'profiles':profiles,'PocketCamera':PocketCamera,'DMG_Mapper':DMG_Mapper,'result':None}
        from contextlib import redirect_stdout,redirect_stderr
        with redirect_stdout(output),redirect_stderr(output): exec(args.get('code',''),namespace)
        return {'output':output.getvalue(),'result':clean(namespace.get('result')),'files':files(*glob.glob('/data/export-*'))}
    if not device: raise RuntimeError('Conecta primero el lector.')
    if device.MODE in device.SUPPORTED_CARTS and action!='inspect' and 'profile' in args:
        index=int(args['profile'])
        if index<0 or index>=len(device.SUPPORTED_CARTS[device.MODE]): raise ValueError('Perfil de cartucho inválido.')
        selected_profile=index
    if action=='disconnect': device.CartPowerOff(); return {}
    if action=='inspect': return inspect(args)
    if not header: raise RuntimeError('Selecciona plataforma para identificar el cartucho.')
    if action=='analyze': return analyze(args)
    if action=='read-rtc':
        header=device.ReadHeader(checkRtc=True); return {'cart':cart_info(args),'rtc':clean(header.get('rtc_dict',{}))}
    if action=='write-rtc':
        guard_cartridge()
        if not args.get('confirmed'): raise ValueError('Confirma los valores del RTC.')
        if device.WriteRTC({'mbc':header.get('mapper_raw',0),'rtc_dict':args['rtcDict']}) is False: raise RuntimeError('No se pudo escribir el RTC.')
        header=device.ReadHeader(checkRtc=True); return {'cart':cart_info(args)}
    if action=='backup-rom':
        path='/data/backup.'+('gb' if device.MODE=='DMG' else 'gba')
        size=int(args.get('romSize') or cart_info(args)['romSize'])
        transfer({'mode':1,'path':path,'mbc':args.get('mbc',header.get('mapper_raw',0)),'rom_size':size,'agb_rom_size':size,'start_addr':0,'fast_read_mode':True,'cart_type':args.get('profile',selected_profile)})
        if args.get('verify',True):
            check='/data/check.bin'
            transfer({'mode':1,'path':check,'mbc':args.get('mbc',header.get('mapper_raw',0)),'rom_size':size,'agb_rom_size':size,'start_addr':0,'fast_read_mode':True,'cart_type':args.get('profile',selected_profile)})
            import hashlib
            if hashlib.sha256(open(path,'rb').read()).digest()!=hashlib.sha256(open(check,'rb').read()).digest(): raise RuntimeError('Las dos lecturas de ROM no coinciden.')
            os.remove(check)
        report='/data/backup-report.txt'
        with open(report,'w') as stream: stream.write(device.GetDumpReport())
        return {'files':files(path,report),'info':clean(device.INFO)}
    if action=='validate-save':
        kind=save_type(args)
        base=DmgSaveTypes(mbc=kind).GetSize() if device.MODE=='DMG' else AgbSaveTypes(kind).GetSize()
        extra=0
        if header.get('has_rtc'):
            if device.MODE=='AGB': extra=16
            else:
                mapper=DMG_Mapper().GetInstance(args={'mbc':header.get('mapper_raw',0)},cart_write_fncptr=device._cart_write,cart_read_fncptr=device._cart_read,cart_powercycle_fncptr=device.CartPowerCycleOrAskReconnect,clk_toggle_fncptr=device._clk_toggle)
                extra=mapper.GetRTCBufferSize()
        if (device.MODE=='DMG' and kind==0x205) or (device.MODE=='AGB' and kind==9): base=batteryless_region(args)['bl_size']
        if not base or args.get('size') not in (base,base+extra): raise ValueError('Tamaño de partida incorrecto: se requieren '+str(base)+' bytes'+(' o '+str(base+extra)+' con RTC.' if extra else '.'))
        return {'size':base,'rtcSize':extra}
    if action=='backup-save': return {'files':files(backup_save(args))}
    if action in ('restore-save','erase-save'):
        if not args.get('confirmed'): raise ValueError('Confirma el reemplazo de la partida.')
        guard_cartridge()
        if action=='restore-save': dispatch('validate-save',{**args,'size':os.path.getsize(args.get('path','/data/input.sav'))})
        kind=save_type(args)
        if not kind: raise ValueError('Tipo de partida no determinado.')
        backup_save(args,'/data/before-write.sav')
        if (device.MODE=='DMG' and kind==0x205) or (device.MODE=='AGB' and kind==9):
            batteryless(action,args,args.get('path','/data/input.sav')); return {'files':files('/data/before-write.sav')}
        targs={'mode':3,'path':args.get('path','/data/input.sav'),'mbc':args.get('mbc',header.get('mapper_raw',0)),'save_type':kind,'rtc':args.get('rtc',True),'cart_type':args.get('profile',selected_profile),'erase':action=='erase-save','verify_write':True}
        calibration=header.get('ereader_calibration')
        if device.MODE=='AGB' and calibration and args.get('keepCalibration',True):
            payload=bytearray([255]*AgbSaveTypes(kind).GetSize()) if action=='erase-save' else bytearray(open(targs['path'],'rb').read())
            payload[0xd000:0xf000]=calibration; targs.update(buffer=payload,path=None,erase=False)
        transfer(targs)
        return {'files':files('/data/before-write.sav')}
    if action=='write-rom':
        if not args.get('confirmed'): raise ValueError('Confirma la programación de ROM.')
        guard_cartridge()
        profile=int(args.get('profile',selected_profile))
        carts=list(device.SUPPORTED_CARTS[device.MODE].values())
        if profile<=0 or profile>=len(carts): raise ValueError('Analiza el flashcart o selecciona un perfil de programación.')
        path=args.get('path','/data/input.rom')
        with open(path,'rb') as stream: payload=bytearray(stream.read())
        if path.lower().endswith('.isx'): payload=from_isx(payload)
        maximum=carts[profile].get('flash_size')
        if len(payload)<1024 or (maximum and len(payload)>maximum): raise ValueError('La ROM no cabe en el perfil seleccionado.')
        if not args.get('skipBackup',False):
            transfer({'mode':1,'path':'/data/before-write.rom','mbc':args.get('mbc',header.get('mapper_raw',0)),'rom_size':maximum or len(payload),'agb_rom_size':maximum or len(payload),'start_addr':0,'fast_read_mode':True,'cart_type':profile})
        from FlashGBX.RomFileDMG import RomFileDMG
        imported_mapper=RomFileDMG(payload).GetHeader().get('mapper_raw',header.get('mapper_raw',0)) if device.MODE=='DMG' else 0
        transfer({'mode':4,'path':'','buffer':payload,'cart_type':profile,'override_voltage':False,'prefer_chip_erase':args.get('chipErase',False),'fast_read_mode':True,'verify_write':True,'fix_header':args.get('fixHeader',False),'fix_bootlogo':args.get('fixLogo',False),'mbc':args.get('mbc',imported_mapper),'compare_sectors':True})
        return {'files':files('/data/before-write.rom')}
    if action=='dump-report':
        if 'file_size' not in device.INFO.get('dump_info',{}): raise ValueError('Realiza un respaldo de ROM para generar su informe de dump.')
        path='/data/dump-report.txt'
        with open(path,'w') as stream: stream.write(device.GetDumpReport())
        return {'files':files(path)}
    if action=='firmware-gbflash':
        if not args.get('confirmed') or device.FW['pcb_name']!='GBFlash': raise ValueError('Confirma el firmware para un lector GBFlash.')
        from FlashGBX.hw_GBFlash import FirmwareUpdater
        updater=FirmwareUpdater(AppContext.APP_PATH,'browser')
        status=updater.WriteFirmware(args.get('path','/app/FlashGBX/res/fw_GBFlash.zip'),lambda text,**kwargs:browser_io.emit(json.dumps({'action':'UPDATE_INFO','text':text,**clean(kwargs)})))
        if status!=1: raise RuntimeError('La actualización de firmware no se completó (código '+str(status)+').')
        return {'reconnect':True}
    raise ValueError('Acción desconocida: '+action)

def dispatch_json(request):
    global transfer_size,transfer_pos,operation_error,last_progress
    transfer_size=0; transfer_pos=0; operation_error=None; last_progress=0
    request=json.loads(request); action=request['action']; args=request.get('args',{})
    try:
        result=dispatch(action,args)
        return json.dumps(result)
    finally:
        if device and device.DEVICE and device.DEVICE.isOpen() and action!='firmware-gbflash':
            try: device.CartPowerOff()
            except Exception: pass
