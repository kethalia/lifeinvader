// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Lifeinvader } from "../src/Lifeinvader.sol";

interface Vm {
    function expectEmit(
        bool checkTopic1,
        bool checkTopic2,
        bool checkTopic3,
        bool checkData,
        address emitter
    ) external;

    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
}

contract LifeinvaderTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    Lifeinvader private lifeinvader;

    event PostPublished(
        uint256 indexed postId, address indexed author, string body, bytes mediaCid
    );
    event CommentPublished(
        uint256 indexed commentId,
        uint256 indexed postId,
        address indexed author,
        string body,
        bytes mediaCid
    );
    event RepostPublished(uint256 indexed postId, address indexed account);
    event LikeSet(
        Lifeinvader.ContentKind indexed contentKind,
        uint256 indexed contentId,
        address indexed account,
        bool liked
    );
    event FollowSet(address indexed follower, address indexed followed, bool following);
    event ProfileSet(address indexed account, string displayName, string bio, bytes avatarCid);
    event DirectMessageSent(
        bytes32 indexed conversationId,
        address indexed sender,
        address indexed recipient,
        uint256 messageId,
        string body,
        bytes mediaCid
    );
    event GroupCreated(
        uint256 indexed groupId, address indexed creator, string name, bytes metadataCid
    );
    event GroupMembershipSet(uint256 indexed groupId, address indexed account, bool joined);
    event GroupMessageSent(
        uint256 indexed groupId,
        address indexed sender,
        uint256 indexed messageId,
        string body,
        bytes mediaCid
    );

    function setUp() public {
        lifeinvader = new Lifeinvader();
    }

    function test_initialIdentifiersStartAtOne() public view {
        _assertEq(lifeinvader.nextPostId(), 1);
        _assertEq(lifeinvader.nextCommentId(), 1);
        _assertEq(lifeinvader.nextMessageId(), 1);
        _assertEq(lifeinvader.nextGroupId(), 1);
    }

    function test_publishPostEmitsTextAndAdvancesIdentifier() public {
        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit PostPublished(1, address(this), "Privacy was a bug", bytes(""));

        uint256 postId = lifeinvader.publishPost("Privacy was a bug", bytes(""));

        _assertEq(postId, 1);
        _assertEq(lifeinvader.nextPostId(), 2);
    }

    function test_publishPostAcceptsMediaWithoutText() public {
        bytes memory cid = hex"01701220aabbccdd";

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit PostPublished(1, address(this), "", cid);

        lifeinvader.publishPost("", cid);
    }

    function test_publishPostRejectsAnEmptyPayload() public {
        vm.expectRevert(Lifeinvader.EmptyPayload.selector);
        lifeinvader.publishPost("", bytes(""));
    }

    function test_publishPostRejectsAnOversizedBody() public {
        string memory body = string(new bytes(lifeinvader.MAX_BODY_BYTES() + 1));

        vm.expectRevert(
            abi.encodeWithSelector(
                Lifeinvader.BodyTooLarge.selector,
                lifeinvader.MAX_BODY_BYTES() + 1,
                lifeinvader.MAX_BODY_BYTES()
            )
        );
        lifeinvader.publishPost(body, bytes(""));
    }

    function test_publishPostRejectsAnOversizedMediaCid() public {
        bytes memory cid = new bytes(lifeinvader.MAX_MEDIA_CID_BYTES() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                Lifeinvader.MediaCidTooLarge.selector,
                lifeinvader.MAX_MEDIA_CID_BYTES() + 1,
                lifeinvader.MAX_MEDIA_CID_BYTES()
            )
        );
        lifeinvader.publishPost("", cid);
    }

    function test_publishPostAcceptsExactPayloadLimits() public {
        string memory body = string(new bytes(lifeinvader.MAX_BODY_BYTES()));
        bytes memory cid = new bytes(lifeinvader.MAX_MEDIA_CID_BYTES());

        uint256 postId = lifeinvader.publishPost(body, cid);

        _assertEq(postId, 1);
    }

    function test_publishCommentEmitsAndAdvancesIdentifier() public {
        uint256 postId = lifeinvader.publishPost("Parent", bytes(""));

        vm.expectEmit(true, true, true, true, address(lifeinvader));
        emit CommentPublished(1, postId, address(this), "Reply", bytes(""));

        uint256 commentId = lifeinvader.publishComment(postId, "Reply", bytes(""));

        _assertEq(commentId, 1);
        _assertEq(lifeinvader.nextCommentId(), 2);
    }

    function test_publishCommentRejectsAnUnknownPost() public {
        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownPost.selector, 1));
        lifeinvader.publishComment(1, "Reply", bytes(""));
    }

    function test_publishRepostEmitsForAnExistingPost() public {
        uint256 postId = lifeinvader.publishPost("Parent", bytes(""));

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit RepostPublished(postId, address(this));

        lifeinvader.publishRepost(postId);
    }

    function test_publishRepostRejectsAnUnknownPost() public {
        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownPost.selector, 0));
        lifeinvader.publishRepost(0);
    }

    function test_setLikeEmitsLatestStateForPostsAndComments() public {
        uint256 postId = lifeinvader.publishPost("Parent", bytes(""));
        uint256 commentId = lifeinvader.publishComment(postId, "Reply", bytes(""));

        vm.expectEmit(true, true, true, true, address(lifeinvader));
        emit LikeSet(Lifeinvader.ContentKind.Post, postId, address(this), true);
        lifeinvader.setLike(Lifeinvader.ContentKind.Post, postId, true);

        vm.expectEmit(true, true, true, true, address(lifeinvader));
        emit LikeSet(Lifeinvader.ContentKind.Comment, commentId, address(this), false);
        lifeinvader.setLike(Lifeinvader.ContentKind.Comment, commentId, false);
    }

    function test_setLikeRejectsUnknownContent() public {
        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownPost.selector, 1));
        lifeinvader.setLike(Lifeinvader.ContentKind.Post, 1, true);

        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownComment.selector, 1));
        lifeinvader.setLike(Lifeinvader.ContentKind.Comment, 1, true);
    }

    function test_setFollowEmitsLatestState() public {
        address followed = address(0xB0B);

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit FollowSet(address(this), followed, true);
        lifeinvader.setFollow(followed, true);

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit FollowSet(address(this), followed, false);
        lifeinvader.setFollow(followed, false);
    }

    function test_setFollowRejectsTheZeroAddress() public {
        vm.expectRevert(Lifeinvader.ZeroAddress.selector);
        lifeinvader.setFollow(address(0), true);
    }

    function test_setProfileEmitsCompleteSnapshot() public {
        bytes memory avatarCid = hex"01701220aabbccdd";

        vm.expectEmit(true, false, false, true, address(lifeinvader));
        emit ProfileSet(address(this), "Tracey", "Living transparently", avatarCid);

        lifeinvader.setProfile("Tracey", "Living transparently", avatarCid);
    }

    function test_setProfileAcceptsAnEmptySnapshotToClearTheDerivedProfile() public {
        vm.expectEmit(true, false, false, true, address(lifeinvader));
        emit ProfileSet(address(this), "", "", bytes(""));

        lifeinvader.setProfile("", "", bytes(""));
    }

    function test_setProfileEnforcesFieldLimits() public {
        string memory displayName = string(new bytes(lifeinvader.MAX_DISPLAY_NAME_BYTES() + 1));
        string memory bio = string(new bytes(lifeinvader.MAX_BIO_BYTES() + 1));

        vm.expectRevert(
            abi.encodeWithSelector(
                Lifeinvader.DisplayNameTooLarge.selector,
                lifeinvader.MAX_DISPLAY_NAME_BYTES() + 1,
                lifeinvader.MAX_DISPLAY_NAME_BYTES()
            )
        );
        lifeinvader.setProfile(displayName, "", bytes(""));

        vm.expectRevert(
            abi.encodeWithSelector(
                Lifeinvader.BioTooLarge.selector,
                lifeinvader.MAX_BIO_BYTES() + 1,
                lifeinvader.MAX_BIO_BYTES()
            )
        );
        lifeinvader.setProfile("", bio, bytes(""));
    }

    function test_sendDirectMessageEmitsPublicConversationAndAdvancesIdentifier() public {
        address recipient = address(0xB0B);
        bytes32 expectedConversationId = lifeinvader.conversationId(address(this), recipient);

        vm.expectEmit(true, true, true, true, address(lifeinvader));
        emit DirectMessageSent(
            expectedConversationId, address(this), recipient, 1, "This is public", bytes("")
        );

        uint256 messageId = lifeinvader.sendDirectMessage(recipient, "This is public", bytes(""));

        _assertEq(messageId, 1);
        _assertEq(lifeinvader.nextMessageId(), 2);
    }

    function test_sendDirectMessageRejectsTheZeroAddress() public {
        vm.expectRevert(Lifeinvader.ZeroAddress.selector);
        lifeinvader.sendDirectMessage(address(0), "Hello", bytes(""));
    }

    function test_conversationIdIsSymmetric() public view {
        address first = address(0xA11CE);
        address second = address(0xB0B);

        _assertEq(
            lifeinvader.conversationId(first, second), lifeinvader.conversationId(second, first)
        );
    }

    function testFuzz_conversationIdIsSymmetric(address first, address second) public view {
        _assertEq(
            lifeinvader.conversationId(first, second), lifeinvader.conversationId(second, first)
        );
    }

    function test_createGroupEmitsAndAdvancesIdentifier() public {
        bytes memory metadataCid = hex"01701220deadbeef";

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit GroupCreated(1, address(this), "Bagholders", metadataCid);

        uint256 groupId = lifeinvader.createGroup("Bagholders", metadataCid);

        _assertEq(groupId, 1);
        _assertEq(lifeinvader.nextGroupId(), 2);
    }

    function test_createGroupEnforcesNameLimits() public {
        vm.expectRevert(Lifeinvader.EmptyGroupName.selector);
        lifeinvader.createGroup("", bytes(""));

        string memory name = string(new bytes(lifeinvader.MAX_GROUP_NAME_BYTES() + 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                Lifeinvader.GroupNameTooLarge.selector,
                lifeinvader.MAX_GROUP_NAME_BYTES() + 1,
                lifeinvader.MAX_GROUP_NAME_BYTES()
            )
        );
        lifeinvader.createGroup(name, bytes(""));
    }

    function test_setGroupMembershipEmitsLatestState() public {
        uint256 groupId = lifeinvader.createGroup("Bagholders", bytes(""));

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit GroupMembershipSet(groupId, address(this), true);
        lifeinvader.setGroupMembership(groupId, true);
    }

    function test_sendGroupMessageIsPublicAndSharesMessageSequence() public {
        uint256 groupId = lifeinvader.createGroup("Bagholders", bytes(""));
        lifeinvader.sendDirectMessage(address(0xB0B), "First", bytes(""));

        vm.expectEmit(true, true, true, true, address(lifeinvader));
        emit GroupMessageSent(groupId, address(this), 2, "Second", bytes(""));

        uint256 messageId = lifeinvader.sendGroupMessage(groupId, "Second", bytes(""));

        _assertEq(messageId, 2);
        _assertEq(lifeinvader.nextMessageId(), 3);
    }

    function test_groupActionsRejectAnUnknownGroup() public {
        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownGroup.selector, 1));
        lifeinvader.setGroupMembership(1, true);

        vm.expectRevert(abi.encodeWithSelector(Lifeinvader.UnknownGroup.selector, 1));
        lifeinvader.sendGroupMessage(1, "Hello", bytes(""));
    }

    function test_actionsUseTheTransactionSender() public {
        address account = address(0xA11CE);

        vm.expectEmit(true, true, false, true, address(lifeinvader));
        emit PostPublished(1, account, "From Alice", bytes(""));

        vm.prank(account);
        lifeinvader.publishPost("From Alice", bytes(""));
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        assert(actual == expected);
    }

    function _assertEq(bytes32 actual, bytes32 expected) private pure {
        assert(actual == expected);
    }
}
