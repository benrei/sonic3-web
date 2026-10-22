// Emulated 68000 work RAM ($FFFF0000-$FFFFFFFF) for the camera / level-event / deformation
// ports. Addresses below are the real RAM addresses ($FFxxxx) of the variables, computed
// from sonic3k.constants.asm, so code ported from the disassembly can do the same mixed
// .b/.w/.l accesses on neighbouring variables (e.g. `move.l d0,(Camera_min_X_pos).w` sets
// min and max X at once, `clr.l (Events_fg_4).w` clears Events_fg_4 and Events_fg_5).
export const R = {
  HScroll_table: 0xffa800,
  H_scroll_buffer: 0xffe000,
  H_scroll_buffer_end: 0xffe380,
  Stat_table: 0xffe400, // = Pos_table_P2: Ctrl_1_logical + status per frame (Tails' CPU)
  Pos_table: 0xffe500,
  Camera_RAM: 0xffee00,
  H_scroll_amount: 0xffee00,
  V_scroll_amount: 0xffee02,
  H_scroll_amount_P2: 0xffee04,
  V_scroll_amount_P2: 0xffee06,
  _unkEE08: 0xffee08,
  Scroll_lock: 0xffee0a,
  Scroll_lock_P2: 0xffee0b,
  Camera_target_min_X_pos: 0xffee0c,
  Camera_target_max_X_pos: 0xffee0e,
  Camera_target_min_Y_pos: 0xffee10,
  Camera_target_max_Y_pos: 0xffee12,
  Camera_min_X_pos: 0xffee14,
  Camera_max_X_pos: 0xffee16,
  Camera_min_Y_pos: 0xffee18,
  Camera_max_Y_pos: 0xffee1a,
  Camera_min_X_pos_P2: 0xffee1c,
  Camera_max_X_pos_P2: 0xffee1e,
  Camera_min_Y_pos_P2: 0xffee20,
  Camera_max_Y_pos_P2: 0xffee22,
  H_scroll_frame_offset: 0xffee24,
  Pos_table_index: 0xffee26,
  H_scroll_frame_offset_P2: 0xffee28,
  Pos_table_index_P2: 0xffee2a,
  Distance_from_top: 0xffee2c,
  Distance_from_top_P2: 0xffee2e,
  Deform_lock: 0xffee30,
  Camera_max_Y_pos_changing: 0xffee32,
  Dynamic_resize_routine: 0xffee33,
  Fast_V_scroll_flag: 0xffee39,
  V_scroll_value_P2_copy: 0xffee3a,
  Camera_X_diff: 0xffee3e,
  Camera_Y_diff: 0xffee40,
  Ring_start_addr_ROM: 0xffee42,
  Ring_end_addr_ROM: 0xffee46,
  Ring_start_addr_RAM: 0xffee4a,
  Apparent_zone_and_act: 0xffee4e,
  Apparent_zone: 0xffee4e,
  Apparent_act: 0xffee4f,
  Palette_fade_timer: 0xffee50,
  Competition_time_record: 0xffee52,
  Competition_time_record_minute: 0xffee53,
  Competition_time_record_second: 0xffee54,
  Competition_time_record_frame: 0xffee55,
  Competition_time_record_P2: 0xffee56,
  Competition_time_record_minute_P2: 0xffee57,
  Competition_time_record_second_P2: 0xffee58,
  Competition_time_record_frame_P2: 0xffee59,
  Competition_time_attack_new_top_record: 0xffee5a,
  Competition_lap_count: 0xffee5c,
  Competition_lap_count_2P: 0xffee5d,
  Act3_flag: 0xffee5e,
  Camera_X_pos_P2: 0xffee60,
  Camera_Y_pos_P2: 0xffee64,
  Camera_X_pos_P2_copy: 0xffee68,
  Camera_Y_pos_P2_copy: 0xffee6c,
  Camera_X_pos_P2_BG_copy: 0xffee70,
  Camera_Y_pos_P2_BG_copy: 0xffee74,
  Camera_X_pos: 0xffee78,
  Camera_Y_pos: 0xffee7c,
  Camera_X_pos_copy: 0xffee80,
  Camera_Y_pos_copy: 0xffee84,
  Camera_X_pos_rounded: 0xffee88,
  Camera_Y_pos_rounded: 0xffee8a,
  Camera_X_pos_BG_copy: 0xffee8c,
  _unkEE8E: 0xffee8e,
  Camera_Y_pos_BG_copy: 0xffee90,
  Camera_X_pos_BG_rounded: 0xffee94,
  Camera_Y_pos_BG_rounded: 0xffee96,
  _unkEE98: 0xffee98,
  _unkEE9C: 0xffee9c,
  _unkEEA0: 0xffeea0,
  _unkEEA2: 0xffeea2,
  Plane_double_update_flag: 0xffeea4,
  Special_V_int_routine: 0xffeea6,
  Screen_X_wrap_value: 0xffeea8,
  Screen_Y_wrap_value: 0xffeeaa,
  Camera_Y_pos_mask: 0xffeeac,
  Layout_row_index_mask: 0xffeeae,
  _unkEEB0: 0xffeeb0,
  Special_events_routine: 0xffeeb2,
  Events_fg_0: 0xffeeb4,
  Events_fg_1: 0xffeeb6,
  Events_fg_2: 0xffeeb8,
  _unkEEBA: 0xffeeba,
  Level_repeat_offset: 0xffeebc,
  Events_fg_3: 0xffeebe,
  Events_routine_fg: 0xffeec0,
  Events_routine_bg: 0xffeec2,
  Events_fg_4: 0xffeec4,
  Events_fg_5: 0xffeec6,
  Draw_delayed_position: 0xffeec8,
  Draw_delayed_rowcount: 0xffeeca,
  Screen_shake_flag: 0xffeecc,
  Screen_shake_offset: 0xffeece,
  Screen_shake_last_offset: 0xffeed0,
  Events_bg: 0xffeed2,
  SStage_results_object_addr: 0xffeee0,
  FBZ_cloud_addr: 0xffeeea,
  Vscroll_buffer: 0xffeeea,
  _unkEEEA: 0xffeeea,
  _unkEEEE: 0xffeeee,
  _unkEEF2: 0xffeef2,
  _unkEEF4: 0xffeef4,
  _unkEEF6: 0xffeef6,
  _unkEEFA: 0xffeefa,
  Camera_RAM_end: 0xffef00,
  V_scroll_value: 0xfff616,
  V_scroll_value_FG: 0xfff616,
  V_scroll_value_BG: 0xfff618,
  Water_level: 0xfff646,
  Mean_water_level: 0xfff648,
  Target_water_level: 0xfff64a,
  Water_speed: 0xfff64c,
  Water_full_screen_flag: 0xfff64e,
  Water_flag: 0xfff730,
  Level_trigger_array: 0xfff7e0,
  Anim_Counters: 0xfff7f0,
  Normal_palette: 0xfffc00,
  Normal_palette_line_2: 0xfffc20,
  Normal_palette_line_3: 0xfffc40,
  Normal_palette_line_4: 0xfffc60,
  Level_frame_counter: 0xfffe04,
};

// 68000 address space as seen by the ported routines: ROM below $400000, the level layout
// ($FFFF8000-$FFFF8FFF, shared with Level.layout so layout edits show up everywhere) and the
// rest of RAM. Addresses are 24-bit (RAM symbols in R are $FFxxxx).
export class Ram {
  constructor(rom, layout) {
    this.rom = rom.u8;
    this.layout = layout;
    this.u8 = new Uint8Array(0x10000);
    this.dv = new DataView(this.u8.buffer);
  }
  ub(a) {
    a &= 0xffffff;
    if (a >= 0xff0000) {
      if (a >= 0xff8000 && a < 0xff9000) return this.layout[a - 0xff8000];
      return this.u8[a & 0xffff];
    }
    return this.rom[a] ?? 0;
  }
  b(a) { return (this.ub(a) << 24) >> 24; }
  uw(a) {
    a &= 0xffffff;
    if (a >= 0xff0000 && !(a >= 0xff8000 && a < 0xff9000)) return this.dv.getUint16(a & 0xffff);
    return (this.ub(a) << 8) | this.ub(a + 1);
  }
  w(a) { return (this.uw(a) << 16) >> 16; }
  l(a) { return (this.uw(a) << 16) | this.uw(a + 2); }
  setB(a, v) {
    a &= 0xffffff;
    if (a < 0xff0000) return; // ROM
    if (a >= 0xff8000 && a < 0xff9000) this.layout[a - 0xff8000] = v & 0xff;
    else this.u8[a & 0xffff] = v & 0xff;
  }
  setW(a, v) { this.setB(a, v >> 8); this.setB(a + 1, v); }
  setL(a, v) { this.setW(a, v >> 16); this.setW(a + 2, v); }
  addW(a, v) { this.setW(a, this.w(a) + v); return this.w(a); }
  addL(a, v) { this.setL(a, this.l(a) + v); return this.l(a); }
  clear(a, n) { for (let i = 0; i < n; i++) this.setB(a + i, 0); }
}

// 68000 helpers
export const s16 = (v) => (v << 16) >> 16;
export const u16 = (v) => v & 0xffff;
export const s8 = (v) => (v << 24) >> 24;
// swap.w of a 32-bit register
export const swap = (v) => ((v << 16) | ((v >>> 16) & 0xffff)) | 0;

// returned by a BackgroundEvent to skip ScreenEvents' V_scroll_value update (`addq.w #4,sp`)
export const SKIP_VSCROLL = Symbol('skip V_scroll_value update');
