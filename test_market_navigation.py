import unittest
import json
from pathlib import Path

from market_browser_bot import Image
from market_navigation import (NavigationError, locate_player, build_resource_graph,
                               shortest_path, map_signature, check_map,
                               minimap_to_world, world_to_minimap)
from market_map_resources import WzReader


class NavigationTests(unittest.TestCase):
    def test_unique_marker_and_red_shops(self):
        image=Image.new('RGB',(150,100),'#333333')
        image.paste('yellow',(23,34,27,38));image.paste('red',(45,34,49,38))
        self.assertEqual(locate_player(image,[10,10,100,80]),(14.5,25.5))

    def test_missing_or_ambiguous_player_stops(self):
        image=Image.new('RGB',(100,100),'black')
        with self.assertRaises(NavigationError):locate_player(image,[0,0,100,100])
        image.paste('yellow',(10,10,14,14));image.paste('yellow',(30,30,34,34))
        with self.assertRaises(NavigationError):locate_player(image,[0,0,100,100])

    def test_changed_map_stops(self):
        image=Image.new('RGB',(100,100),'black')
        profile=dict(minimap=[0,0,100,100],signature=map_signature(image,[0,0,100,100]).tolist())
        check_map(image,profile)
        with self.assertRaises(NavigationError):check_map(Image.new('RGB',(100,100),'white'),profile)

    def fixture(self):
        return dict(footholds=[dict(x1=0,x2=200,y1=100,y2=100),dict(x1=200,x2=400,y1=100,y2=100),
                               dict(x1=0,x2=400,y1=300,y2=300),dict(x1=0,x2=0,y1=100,y2=300)],
                    ladders=[dict(x=150,y1=102,y2=240)])

    def test_merge_floors_exclude_walls_and_jump_gap(self):
        graph=build_resource_graph(self.fixture())
        self.assertEqual(len(graph['floors']),2)
        edge=next(e for e in graph['edges'] if e['kind']=='ladder')
        self.assertEqual(edge['grab_gap'],60)
        for i in range(len(graph['nodes'])):self.assertEqual(shortest_path(graph,0,i)[-1],i)

    def test_unconnected_floor_rejected(self):
        fixture=self.fixture();fixture['ladders']=[]
        with self.assertRaises(NavigationError):build_resource_graph(fixture)

    def test_coordinate_transform_quantization(self):
        meta=dict(mag=4,centerX=688,centerY=-615)
        n=dict(x=335,y=975)
        world=minimap_to_world(world_to_minimap(n,meta),meta)
        self.assertTrue(0<=n['x']-world[0]<16 and 0<=n['y']-world[1]<16)

    def test_marker_offset_preserves_world_transform(self):
        meta=dict(mag=4,centerX=688,centerY=-615,marker_offset=[0,-6])
        n=dict(x=335,y=975)
        self.assertEqual(world_to_minimap(n,meta),(63,16))
        self.assertEqual(minimap_to_world((63,16),meta),(320,967))

    def test_minimap_artwork_ambiguity(self):
        import numpy as np
        from market_auto_calibration import find_minimap
        rng=np.random.default_rng(12)
        rgb=rng.integers(30,220,(20,30,3),dtype=np.uint8)
        template=Image.fromarray(rgb).convert('RGBA')
        scene=Image.new('RGB',(180,120),'#555555');scene.paste(template,(31,22))
        self.assertEqual(find_minimap(scene,template)[0],[31,22,30,20])
        scene.paste(template,(101,72))
        with self.assertRaises(NavigationError):find_minimap(scene,template)

    def test_wz_bounds_and_strings(self):
        encoded=bytes([253])+bytes(c^(0xaa+i) for i,c in enumerate(b'abc'))
        self.assertEqual(WzReader(encoded).string(),'abc')
        with self.assertRaises(ValueError):WzReader(b'').number('i')
        with self.assertRaises(ValueError):WzReader(b'abc').take(-1)

    def test_wz_nested_property(self):
        def string(s):return bytes([(-len(s))&255])+bytes(c^((0xaa+i)&255) for i,c in enumerate(s.encode()))
        # One compressed integer property named x.
        self.assertEqual(WzReader(b'\x01\x00'+string('x')+b'\x03\x2a').properties(),{'x':42})


if __name__=='__main__':unittest.main()
